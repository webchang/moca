//go:build linux || darwin

package control

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	egressv1 "github.com/rossoctl/moca/gen/go/egress/v1"
	"google.golang.org/protobuf/proto"
)

type regCall struct {
	vmID, sid string
	grant     []byte
	ln        net.Listener
}

// recorder is a Handler that records calls. closeOnUnregister makes Unregister close the
// listener it was given, which is what a real moca-egress does.
type recorder struct {
	mu                sync.Mutex
	regs              chan regCall
	unregs            chan string
	listeners         map[string]net.Listener
	closeOnUnregister bool
}

func newRecorder() *recorder {
	return &recorder{regs: make(chan regCall, 16), unregs: make(chan string, 16), listeners: map[string]net.Listener{}}
}

func (r *recorder) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	r.mu.Lock()
	r.listeners[vmID] = ln
	r.mu.Unlock()
	r.regs <- regCall{vmID, sid, grant, ln}
	return nil
}

func (r *recorder) Unregister(vmID string) error {
	r.mu.Lock()
	ln := r.listeners[vmID]
	delete(r.listeners, vmID)
	r.mu.Unlock()
	if ln != nil && r.closeOnUnregister {
		_ = ln.Close()
	}
	r.unregs <- vmID
	return nil
}

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "ectl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}

func startServer(t *testing.T, path string, uids []int, h Handler) *Server {
	t.Helper()
	s, err := NewServer(path, uids, h)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// vmListener creates a listening unix socket and returns its path and an *os.File for it.
func vmListener(t *testing.T, dir, name string) (string, *net.UnixListener, *os.File) {
	t.Helper()
	p := filepath.Join(dir, name)
	ul, err := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	f, err := ul.File()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close(); _ = ul.Close() })
	return p, ul, f
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for handler call")
		panic("unreachable")
	}
}

func TestRegisterPassesAWorkingListener(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()

	vmPath, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("got %q %q", call.vmID, call.sid)
	}
	accepted := make(chan error, 1)
	go func() {
		conn, err := call.ln.Accept()
		if err == nil {
			conn.Close()
		}
		accepted <- err
	}()
	conn, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := recv(t, accepted); err != nil {
		t.Fatalf("handler accept: %v", err)
	}
}

func TestRegisterWithoutAnFdIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	uc := conn.(*net.UnixConn)
	req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Register{
		Register: &egressv1.Register{VmId: "vm-1", Sid: "s"}}}
	err = roundTrip(uc, req, -1)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

func TestRegisterWithANonListeningSocketIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	err = c.Register(ctx(t), "vm-1", "s", nil, f)
	var re *RefusalError
	if !errors.As(err, &re) || re.Code != "bad_request" {
		t.Fatalf("want bad_request, got %v", err)
	}
}

// The refusal must be the peer-UID check itself: the server closes a disallowed peer's
// connection without reading a frame or sending a reply, so the client reads EOF. A dial
// failure or any other error would not be this, and fails the test. (#582 review)
func TestServerRefusesAPeerOutsideAllowedUIDs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		allowed []int
		refused bool
	}{
		{"disallowed uid", []int{os.Getuid() + 1}, true},
		{"allowed uid (control)", []int{os.Getuid()}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := shortDir(t)
			path := filepath.Join(dir, "c.sock")
			h := newRecorder()
			startServer(t, path, tc.allowed, h)
			conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatalf("dial: %v", err) // a dial failure is not the UID check
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
				Unregister: &egressv1.Unregister{VmId: "vm-x"}}}
			// A refused peer may already be closed, so a failed write is expected there.
			werr := writeFrame(conn, req, -1)
			body, _, rerr := readFrame(conn)
			if !tc.refused {
				if werr != nil || rerr != nil {
					t.Fatalf("allowed peer: write %v, read %v", werr, rerr)
				}
				var reply egressv1.ControlReply
				if err := proto.Unmarshal(body, &reply); err != nil || !reply.GetOk() {
					t.Fatalf("allowed peer got reply %v (%v)", &reply, err)
				}
				return
			}
			if rerr == nil {
				t.Fatalf("disallowed peer got a reply frame (%d bytes)", len(body))
			}
			if !errors.Is(rerr, io.EOF) && !errors.Is(rerr, io.ErrUnexpectedEOF) && !errors.Is(rerr, syscall.ECONNRESET) {
				t.Fatalf("disallowed peer: want the server to close without a reply (EOF), got %v", rerr)
			}
			select {
			case v := <-h.regs:
				t.Fatalf("handler saw %v", v)
			case v := <-h.unregs:
				t.Fatalf("handler saw Unregister(%s) from a disallowed peer", v)
			default:
			}
		})
	}
}

func TestControlDisconnectUnregistersItsBindings(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	_, _, f1 := vmListener(t, dir, "vm1.sock")
	_, _, f2 := vmListener(t, dir, "vm2.sock")
	for id, f := range map[string]*os.File{"vm-1": f1, "vm-2": f2} {
		if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
			t.Fatal(err)
		}
		recv(t, h.regs)
	}
	c.Close()
	got := map[string]bool{recv(t, h.unregs): true, recv(t, h.unregs): true}
	if !got["vm-1"] || !got["vm-2"] {
		t.Fatalf("unregistered %v", got)
	}
}

func TestClientReplaysRegistrationsAfterServerRestart(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	h1.closeOnUnregister = true // proves the client's dup keeps the socket alive
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()

	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h1.regs)

	// The caller drops its own copy; only the client's dup remains.
	f.Close()
	ul.SetUnlinkOnClose(false)
	ul.Close()

	s1.Close()
	if got := recv(t, h1.unregs); got != "vm-1" {
		t.Fatalf("old server unregistered %q", got)
	}

	// Nobody is accepting, but the backlog still takes the connection.
	gap, err := net.Dial("unix", vmPath)
	if err != nil {
		t.Fatalf("dial during gap: %v", err)
	}
	defer gap.Close()

	h2 := newRecorder()
	startServer(t, ctlPath, []int{os.Getuid()}, h2)
	if err := c.Unregister(ctx(t), "vm-other"); err != nil {
		t.Fatal(err)
	}
	call := recv(t, h2.regs)
	if call.vmID != "vm-1" || call.sid != "run-a" {
		t.Fatalf("replayed %q %q", call.vmID, call.sid)
	}
	type res struct {
		conn net.Conn
		err  error
	}
	ch := make(chan res, 1)
	go func() { cn, err := call.ln.Accept(); ch <- res{cn, err} }()
	r := recv(t, ch)
	if r.err != nil {
		t.Fatalf("accept: %v", r.err)
	}
	r.conn.Close()
}

func TestOversizeFrameIsRefused(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], maxFrame+1)
	if _, err := conn.Write(hdr[:]); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the server to close the connection")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("server did not close the connection")
	}
	select {
	case v := <-h.regs:
		t.Fatalf("handler saw %v", v)
	default:
	}
}

// refuser refuses the listed VMs and otherwise records like recorder.
type refuser struct {
	*recorder
	refuse map[string]bool
}

func (r *refuser) Register(vmID, sid string, grant []byte, ln net.Listener) error {
	if r.refuse[vmID] {
		return errors.New("no")
	}
	return r.recorder.Register(vmID, sid, grant, ln)
}

func TestClientEvictsARefusedReplayAndKeepsServing(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()
	for _, id := range []string{"vm-1", "vm-2", "vm-3"} {
		_, _, f := vmListener(t, dir, id+".sock")
		if id == "vm-3" {
			s1.Close()
			h2 := &refuser{newRecorder(), map[string]bool{"vm-1": true}}
			startServer(t, ctlPath, []int{os.Getuid()}, h2)
			if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
				t.Fatalf("register after restart: %v", err)
			}
			got := map[string]bool{recv(t, h2.regs).vmID: true, recv(t, h2.regs).vmID: true}
			if !got["vm-2"] || !got["vm-3"] || got["vm-1"] {
				t.Fatalf("new handler holds %v", got)
			}
			c.mu.Lock()
			_, stale := c.live["vm-1"]
			conn := c.conn
			c.mu.Unlock()
			if stale {
				t.Fatal("vm-1 not evicted")
			}
			if err := c.Unregister(ctx(t), "vm-other"); err != nil {
				t.Fatalf("follow-up call: %v", err)
			}
			c.mu.Lock()
			same := c.conn == conn
			c.mu.Unlock()
			if !same {
				t.Fatal("follow-up call redialled")
			}
			return
		}
		if err := c.Register(ctx(t), id, "s", nil, f); err != nil {
			t.Fatal(err)
		}
		recv(t, h1.regs)
	}
}

func TestFdOnAnUnregisterFrameIsClosed(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	conn, err := net.Dial("unix", filepath.Join(dir, "c.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	req := &egressv1.ControlRequest{Msg: &egressv1.ControlRequest_Unregister{
		Unregister: &egressv1.Unregister{VmId: "vm-1"}}}
	if err := roundTrip(conn.(*net.UnixConn), req, int(f.Fd())); err != nil {
		t.Fatal(err)
	}
	// Once every other copy is gone, the socket survives only if the server leaked its fd.
	f.Close()
	ul.Close()
	assertSocketGone(t, vmPath)
}

func TestClientClosesItsDupAfterUnregister(t *testing.T) {
	dir := shortDir(t)
	h := newRecorder()
	h.closeOnUnregister = true
	startServer(t, filepath.Join(dir, "c.sock"), []int{os.Getuid()}, h)
	c := NewClient(filepath.Join(dir, "c.sock"))
	defer c.Close()
	vmPath, ul, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "s", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h.regs)
	c.mu.Lock()
	dup := c.live["vm-1"].fd
	c.mu.Unlock()
	if err := c.Unregister(ctx(t), "vm-1"); err != nil {
		t.Fatal(err)
	}
	recv(t, h.unregs)
	if _, err := unix.FcntlInt(uintptr(dup), unix.F_GETFD, 0); err == nil {
		t.Fatal("dup still open after Unregister")
	}
	f.Close()
	ul.Close()
	assertSocketGone(t, vmPath)
}

// assertSocketGone checks that no process holds the listening socket at path any more:
// the file may remain, but connecting must be refused.
func assertSocketGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.Dial("unix", path)
		if err != nil {
			return
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("listening socket still alive: an fd leaked")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
