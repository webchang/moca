//go:build unix

package control

import (
	"context"
	"errors"
	"fmt"
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

// Client is vmpool's end of the channel. It dials lazily and, because moca-egress can
// restart independently of vmpool, remembers every live registration (with its own dup of
// the listening fd) so it can replay them after a reconnect.
type Client struct {
	path string

	mu   sync.Mutex
	conn *net.UnixConn
	live map[string]*liveReg
}

type liveReg struct {
	sid   string
	grant []byte
	fd    int // client-owned dup of the VM listener
}

// NewClient returns a Client for the control socket at path. It does not dial.
func NewClient(path string) *Client {
	return &Client{path: path, live: map[string]*liveReg{}}
}

// Register hands ln to moca-egress as vmID's listener. ln is duplicated, so the caller keeps
// ownership of its own copy; the dup is what keeps the socket (and its backlog) alive if
// moca-egress restarts, and it is closed on Unregister or Close.
func (c *Client) Register(ctx context.Context, vmID, sessionID string, grant []byte, ln *os.File) error {
	dup, err := dupFile(ln)
	if err != nil {
		return err
	}
	reg := &liveReg{sid: sessionID, grant: grant, fd: dup}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.do(ctx, func(conn *net.UnixConn) error { return roundTrip(conn, registerReq(vmID, reg), reg.fd) }); err != nil {
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
	err := c.do(ctx, func(conn *net.UnixConn) error {
		req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
			Unregister: &egressv1.Unregister{VmId: vmID}}}
		return roundTrip(conn, req, -1)
	})
	if old := c.live[vmID]; old != nil {
		_ = unix.Close(old.fd)
		delete(c.live, vmID)
	}
	return err
}

// Close drops the connection (which makes the server unregister our bindings) and closes
// every dup.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var err error
	if c.conn != nil {
		err = c.conn.Close()
		c.conn = nil
	}
	for id, r := range c.live {
		_ = unix.Close(r.fd)
		delete(c.live, id)
	}
	return err
}

// do runs fn on a live connection. On a transport error it redials, replays every live
// registration, and retries fn once. A refusal is a verdict, not a transport fault, and is
// returned as is.
func (c *Client) do(ctx context.Context, fn func(*net.UnixConn) error) error {
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		conn, err := c.connect(ctx)
		if err == nil {
			stop := bindDeadline(ctx, conn)
			err = fn(conn)
			stop()
		}
		if err == nil {
			return nil
		}
		var re *RefusalError
		if errors.As(err, &re) || ctx.Err() != nil {
			if !errors.As(err, &re) {
				c.dropConn()
			}
			return err
		}
		c.dropConn()
		last = err
	}
	return last
}

// connect returns the live connection, dialling and replaying if there is none.
func (c *Client) connect(ctx context.Context) (*net.UnixConn, error) {
	if c.conn != nil {
		return c.conn, nil
	}
	var d net.Dialer
	nc, err := d.DialContext(ctx, "unix", c.path)
	if err != nil {
		return nil, err
	}
	conn := nc.(*net.UnixConn)
	stop := bindDeadline(ctx, conn)
	defer stop()
	for vm, r := range c.live {
		err := roundTrip(conn, registerReq(vm, r), r.fd)
		var re *RefusalError
		if errors.As(err, &re) {
			// The server's verdict on this old entry says nothing about the call in
			// progress. Keeping it would poison every later call, so evict it.
			log.Printf("egress control: replay of %s refused (%s); evicting", vm, re.Code)
			_ = unix.Close(r.fd)
			delete(c.live, vm)
			continue
		}
		if err != nil {
			_ = conn.Close()
			// %v, not %w: a transport fault must not look like a refusal to do().
			return nil, fmt.Errorf("replay %s: %v", vm, err)
		}
	}
	c.conn = conn
	return conn, nil
}

func (c *Client) dropConn() {
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
}

func registerReq(vmID string, r *liveReg) *egressv1.ControlRequest {
	return &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Register{
		Register: &egressv1.Register{VmId: vmID, Sid: r.sid, Grant: r.grant}}}
}

// roundTrip sends one request and waits for its reply.
func roundTrip(conn *net.UnixConn, req proto.Message, fd int) error {
	if err := writeFrame(conn, req, fd); err != nil {
		return err
	}
	body, fds, err := readFrame(conn)
	if err != nil {
		return err
	}
	closeFDs(fds) // replies never carry fds
	var rep egressv1.ControlReply
	if err := proto.Unmarshal(body, &rep); err != nil {
		return err
	}
	if !rep.GetOk() {
		return &RefusalError{Code: rep.GetCode(), Message: rep.GetMessage()}
	}
	return nil
}

// bindDeadline applies ctx's deadline (or defaultTimeout) to conn and makes cancellation
// interrupt a blocked read or write. The returned func clears both.
func bindDeadline(ctx context.Context, conn *net.UnixConn) (stop func()) {
	dl, ok := ctx.Deadline()
	if !ok {
		dl = time.Now().Add(defaultTimeout)
	}
	_ = conn.SetDeadline(dl)
	unhook := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	return func() {
		unhook()
		_ = conn.SetDeadline(time.Time{})
	}
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
