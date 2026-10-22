//go:build unix

package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/proto"

	egressv1 "github.com/rossoctl/moca/gen/go/egress/v1"
)

// defaultTimeout bounds a call whose context has no deadline, so a wedged moca-egress
// cannot stall VM spawn forever.
const defaultTimeout = 10 * time.Second

// Heal backoff: after the connection is lost while VMs are registered, the client redials
// and replays on its own, starting at healMin and doubling up to healMax. Each attempt is
// bounded by healAttemptTimeout.
const (
	healMin            = 100 * time.Millisecond
	healMax            = 2 * time.Second
	healAttemptTimeout = 2 * time.Second
)

var errClientClosed = errors.New("egress control: client closed")

// Client is vmpool's end of the channel. It dials lazily and, because moca-egress can
// restart independently of vmpool, remembers every live registration (with its own dup of
// the listening fd) so it can replay them after a reconnect.
//
// A connection loss is noticed even while vmpool is idle: every connection has a reader
// goroutine, and the server never speaks unprompted, so EOF on an idle connection means
// moca-egress went away. Whenever the connection is lost with registrations still live, a
// background heal loop redials and replays them with backoff, so a moca-egress restart is
// healed within seconds without waiting for the next Register or Unregister.
type Client struct {
	path string

	// stopCtx is cancelled first thing in Close, so a heal attempt in flight gives up at once.
	stopCtx  context.Context
	stopHeal context.CancelFunc
	wg       sync.WaitGroup // heal loop and per-connection readers

	mu      sync.Mutex
	closed  bool
	healing bool
	conn    *clientConn
	live    map[string]*liveReg
}

type liveReg struct {
	sid   string
	grant []byte
	fd    int // client-owned dup of the VM listener
}

// clientConn is one control connection. Its reader goroutine owns every read: it hands
// each reply to replies and, when the stream ends, records err and closes dead.
type clientConn struct {
	c       *net.UnixConn
	replies chan []byte // capacity 1: at most one call is outstanding (calls hold Client.mu)
	dead    chan struct{}
	err     error // set before dead is closed
}

// NewClient returns a Client for the control socket at path. It does not dial.
func NewClient(path string) *Client {
	sctx, cancel := context.WithCancel(context.Background())
	return &Client{path: path, live: map[string]*liveReg{}, stopCtx: sctx, stopHeal: cancel}
}

// Register hands ln to moca-egress as vmID's listener. ln is duplicated, so the caller keeps
// ownership of its own copy; the dup is what keeps the socket (and its backlog) alive if
// moca-egress restarts, and it is closed on Unregister or Close.
func (c *Client) Register(ctx context.Context, vmID, sessionID string, grant []byte, ln *os.File) error {
	if err := ctx.Err(); err != nil {
		return err // before anything touches the shared connection
	}
	dup, err := dupFile(ln)
	if err != nil {
		return err
	}
	reg := &liveReg{sid: sessionID, grant: grant, fd: dup}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.do(ctx, func(cc *clientConn) error { return cc.call(ctx, registerReq(vmID, reg), reg.fd) }); err != nil {
		_ = unix.Close(dup)
		return err
	}
	if old := c.live[vmID]; old != nil {
		_ = unix.Close(old.fd)
	}
	c.live[vmID] = reg
	return nil
}

// Unregister drops vmID. The local entry and its dup are released even if moca-egress is
// unreachable: a failed call tears the connection down, and the server unbinds everything
// a closed connection owned.
func (c *Client) Unregister(ctx context.Context, vmID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		// No call can be made, but the server must not keep serving vmID. Forget it first,
		// then drop the connection: the server unbinds everything the connection owned and
		// the heal loop re-registers the rest, so the server converges on c.live.
		c.forgetLocked(vmID)
		c.dropConn()
		return err
	}
	err := c.do(ctx, func(cc *clientConn) error {
		req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
			Unregister: &egressv1.Unregister{VmId: vmID}}}
		return cc.call(ctx, req, -1)
	})
	c.forgetLocked(vmID)
	return err
}

func (c *Client) forgetLocked(vmID string) {
	if old := c.live[vmID]; old != nil {
		_ = unix.Close(old.fd)
		delete(c.live, vmID)
	}
}

// Close stops the heal loop, drops the connection (which makes the server unregister our
// bindings), closes every dup, and waits for the client's goroutines to finish.
func (c *Client) Close() error {
	c.stopHeal()
	c.mu.Lock()
	c.closed = true
	var err error
	if c.conn != nil {
		err = c.conn.c.Close()
		c.conn = nil
	}
	for id, r := range c.live {
		_ = unix.Close(r.fd)
		delete(c.live, id)
	}
	c.mu.Unlock()
	c.wg.Wait()
	return err
}

// do runs fn on a live connection. On a transport error it redials, replays every live
// registration, and retries fn once. A refusal is a verdict, not a transport fault, and is
// returned as is. Called with c.mu held.
//
// A call abandoned mid-flight (its ctx expired with the reply still pending) leaves the
// stream out of step, so the connection is dropped. That makes the server unbind every VM
// the connection owned, and the heal loop dropConn starts re-registers them within about
// healMin, with no further call needed.
//
// The cost is host-wide, not per call: unbinding a VM makes moca-egress abort its live
// connections, so ONE call that outlives its ctx -- a Register past egressControlTimeout
// while moca-egress is slow -- severs every in-flight tunnel on the host (an open git clone
// fails; new connections work again once the heal lands). The launcher's calls do not
// inherit the Exec request's cancel, so in practice only a stalled moca-egress gets here.
// Keeping the connection instead (discard the owed reply, or a request id on the wire) is
// tracked as a follow-up.
func (c *Client) do(ctx context.Context, fn func(*clientConn) error) error {
	if c.closed {
		return errClientClosed
	}
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		cc, err := c.connect(ctx)
		if err == nil {
			err = fn(cc)
		}
		if err == nil {
			return nil
		}
		var re *RefusalError
		if errors.As(err, &re) {
			return err
		}
		c.dropConn()
		if ctx.Err() != nil {
			return err
		}
		last = err
	}
	return last
}

// connect returns the live connection, dialling and replaying if there is none. Called
// with c.mu held.
func (c *Client) connect(ctx context.Context) (*clientConn, error) {
	if c.conn != nil {
		return c.conn, nil
	}
	if c.closed {
		return nil, errClientClosed
	}
	var d net.Dialer
	nc, err := d.DialContext(ctx, "unix", c.path)
	if err != nil {
		return nil, err
	}
	cc := &clientConn{c: nc.(*net.UnixConn), replies: make(chan []byte, 1), dead: make(chan struct{})}
	c.wg.Add(1)
	go c.read(cc)
	for vm, r := range c.live {
		err := cc.call(ctx, registerReq(vm, r), r.fd)
		var re *RefusalError
		if errors.As(err, &re) {
			// The server's verdict on this old entry says nothing about the call in
			// progress. Keeping it would poison every later call, so evict it.
			log.Printf("ERROR egress control: replay of vm %s refused (code %s: %s); evicting it, "+
				"the VM has no egress until it is reaped", vm, re.Code, re.Message)
			_ = unix.Close(r.fd)
			delete(c.live, vm)
			continue
		}
		if err != nil {
			_ = cc.c.Close()
			// %v, not %w: a transport fault must not look like a refusal to do().
			return nil, fmt.Errorf("replay %s: %v", vm, err)
		}
	}
	c.conn = cc
	return cc, nil
}

// dropConn closes the current connection and, if registrations are still live, starts the
// heal loop. Called with c.mu held.
func (c *Client) dropConn() {
	if c.conn != nil {
		_ = c.conn.c.Close()
		c.conn = nil
	}
	c.startHealLocked()
}

// startHealLocked starts the heal loop unless one is running, the client is closed, or
// there is nothing to replay. Called with c.mu held; c.closed is set under c.mu before
// Close waits on c.wg, so no Add can race that Wait.
func (c *Client) startHealLocked() {
	if c.healing || c.closed || len(c.live) == 0 {
		return
	}
	c.healing = true
	c.wg.Add(1)
	go c.heal()
}

// heal redials and replays with backoff until connected, until nothing is left to replay,
// or until Close. It takes c.mu only for an attempt, never while sleeping.
func (c *Client) heal() {
	defer c.wg.Done()
	backoff := healMin
	failures := 0
	for {
		t := time.NewTimer(backoff)
		select {
		case <-c.stopCtx.Done():
			t.Stop()
			c.mu.Lock()
			c.healing = false
			c.mu.Unlock()
			return
		case <-t.C:
		}
		c.mu.Lock()
		if c.closed || c.conn != nil || len(c.live) == 0 {
			c.healing = false
			c.mu.Unlock()
			return
		}
		actx, cancel := context.WithTimeout(c.stopCtx, healAttemptTimeout)
		_, err := c.connect(actx)
		cancel()
		if err == nil {
			n := len(c.live)
			c.healing = false
			c.mu.Unlock()
			// Logged on every heal, a first-try one included: after `systemctl restart moca-egress`
			// the redial usually succeeds at once, and this line is then the only trace in the
			// worker's journal that its VMs were re-registered (P4.1 live acceptance, nested-m8i).
			log.Printf("egress control: reconnected to %s after %d failed attempts; replayed %d registrations", c.path, failures, n)
			return
		}
		c.mu.Unlock()
		if failures == 0 && c.stopCtx.Err() == nil {
			log.Printf("egress control: reconnect to %s failed (%v); retrying with backoff up to %s", c.path, err, healMax)
		}
		failures++
		backoff = min(backoff*2, healMax)
	}
}

// read owns cc's reads for its lifetime. The server answers each request with exactly one
// reply and never speaks unprompted, so a reply nobody is waiting for is a protocol fault,
// and end of stream on an idle connection means moca-egress went away.
func (c *Client) read(cc *clientConn) {
	defer c.wg.Done()
	for {
		body, fds, err := readFrame(cc.c)
		closeFDs(fds) // replies never carry fds
		if err == nil {
			select {
			case cc.replies <- body:
				continue
			default:
				err = errors.New("egress control: unsolicited reply")
			}
		}
		_ = cc.c.Close()
		cc.err = err
		close(cc.dead)
		c.mu.Lock()
		if c.conn == cc {
			c.conn = nil
			c.startHealLocked()
		}
		c.mu.Unlock()
		return
	}
}

func registerReq(vmID string, r *liveReg) *egressv1.ControlRequest {
	return &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Register{
		Register: &egressv1.Register{VmId: vmID, Sid: r.sid, Grant: r.grant}}}
}

// call sends one request and waits for its reply, bounded by ctx (or defaultTimeout when
// ctx has no deadline).
func (cc *clientConn) call(ctx context.Context, req proto.Message, fd int) error {
	dl, ok := ctx.Deadline()
	if !ok {
		dl = time.Now().Add(defaultTimeout)
	}
	_ = cc.c.SetWriteDeadline(dl)
	unhook := context.AfterFunc(ctx, func() { _ = cc.c.SetWriteDeadline(time.Unix(1, 0)) })
	err := writeFrame(cc.c, req, fd)
	unhook()
	_ = cc.c.SetWriteDeadline(time.Time{})
	if err != nil {
		return err
	}
	t := time.NewTimer(time.Until(dl))
	defer t.Stop()
	var body []byte
	select {
	case body = <-cc.replies:
	case <-cc.dead:
		select {
		case body = <-cc.replies: // the reply landed just before the stream ended
		default:
			if cc.err == nil || errors.Is(cc.err, io.EOF) {
				return io.ErrUnexpectedEOF
			}
			return cc.err
		}
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return os.ErrDeadlineExceeded
	}
	return parseReply(body)
}

// roundTrip sends one request on a raw connection and reads its reply inline. It is for
// connections without a reader goroutine (tests driving the server directly).
func roundTrip(conn *net.UnixConn, req proto.Message, fd int) error {
	if err := writeFrame(conn, req, fd); err != nil {
		return err
	}
	body, fds, err := readFrame(conn)
	if err != nil {
		return err
	}
	closeFDs(fds) // replies never carry fds
	return parseReply(body)
}

func parseReply(body []byte) error {
	var rep egressv1.ControlReply
	if err := proto.Unmarshal(body, &rep); err != nil {
		return err
	}
	if !rep.GetOk() {
		return &RefusalError{Code: rep.GetCode(), Message: rep.GetMessage()}
	}
	return nil
}

// dupFile duplicates f's descriptor without Fd(), which would flip a Go-managed
// non-blocking socket to blocking and break its owner's poller.
func dupFile(f *os.File) (int, error) {
	raw, err := f.SyscallConn()
	if err != nil {
		return -1, err
	}
	dup := -1
	var derr error
	if err := raw.Control(func(fd uintptr) {
		// F_DUPFD_CLOEXEC is atomic, so a concurrent fork cannot inherit the dup.
		dup, derr = unix.FcntlInt(fd, unix.F_DUPFD_CLOEXEC, 0)
	}); err != nil {
		return -1, err
	}
	return dup, derr
}
