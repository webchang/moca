//go:build linux || darwin

package control

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// proxyLike models moca-egress's Handler where it matters here: a second Register for a VM it
// still holds is refused as a duplicate, and Unregister drops whatever binding is current.
// gate, when set, parks Unregister until the test releases it, widening dropConn's window.
type proxyLike struct {
	mu      sync.Mutex
	bound   map[string]net.Listener
	refused []string
	gate    chan struct{}
	inUnreg chan string
}

func newProxyLike() *proxyLike {
	return &proxyLike{bound: map[string]net.Listener{}, inUnreg: make(chan string, 4)}
}

func (p *proxyLike) Register(vmID, _ string, _ []byte, ln net.Listener) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.bound[vmID]; ok {
		p.refused = append(p.refused, vmID)
		return errors.New("duplicate_vm")
	}
	p.bound[vmID] = ln
	return nil
}

func (p *proxyLike) Unregister(vmID string) error {
	p.inUnreg <- vmID
	p.mu.Lock()
	gate := p.gate
	p.mu.Unlock()
	if gate != nil {
		<-gate
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if ln := p.bound[vmID]; ln != nil {
		_ = ln.Close()
	}
	delete(p.bound, vmID)
	return nil
}

func (p *proxyLike) isBound(vmID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.bound[vmID]
	return ok
}

// A connection that drops while a redialled one re-registers the same VM must end with that
// VM bound -- neither refused as a duplicate (Register racing ahead of the stale Unregister)
// nor torn down (the stale Unregister landing after the new Register). #582 review.
func TestReRegisterRacingADroppedConnectionEndsBound(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	p := newProxyLike()
	startServer(t, ctlPath, []int{os.Getuid()}, p)

	_, ul, f := vmListener(t, dir, "vm.sock")
	defer ul.Close()
	defer f.Close()

	old := NewClient(ctlPath)
	if err := old.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}

	// Park the drop's Unregister inside the handler, then re-register from a new connection.
	// The gate is released on every exit, so a failing assertion cannot leave the server's
	// connection goroutine parked and hang the suite at Server.Close.
	gate := make(chan struct{})
	p.mu.Lock()
	p.gate = gate
	p.mu.Unlock()
	var release sync.Once
	open := func() { release.Do(func() { close(gate) }) }
	t.Cleanup(open)
	_ = old.Close()
	select {
	case <-p.inUnreg:
	case <-time.After(2 * time.Second):
		t.Fatal("dropConn never reached Unregister")
	}

	fresh := NewClient(ctlPath)
	defer fresh.Close()
	regDone := make(chan error, 1)
	go func() { regDone <- fresh.Register(ctx(t), "vm-1", "run-a", nil, f) }()

	// Before the fix the re-Register raced past the parked Unregister: the handler still held
	// vm-1, so it was refused. With the fix it waits for the drop to finish.
	select {
	case err := <-regDone:
		t.Fatalf("re-Register completed while the stale Unregister was still in progress (err=%v)", err)
	case <-time.After(200 * time.Millisecond):
	}
	open()
	select {
	case err := <-regDone:
		if err != nil {
			t.Fatalf("re-Register after the drop: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("re-Register never completed after the drop finished")
	}
	if !p.isBound("vm-1") {
		t.Fatal("vm-1 is not bound after the re-Register: the stale Unregister tore it down")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.refused) != 0 {
		t.Fatalf("handler refused %v as duplicates", p.refused)
	}
}

// The supersede path: a second connection registers a VM the first still owns. The stale
// binding is unbound first, so the handler sees Unregister then Register and ends bound.
func TestRegisterFromASecondConnectionSupersedes(t *testing.T) {
	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	p := newProxyLike()
	startServer(t, ctlPath, []int{os.Getuid()}, p)
	_, ul, f := vmListener(t, dir, "vm.sock")
	defer ul.Close()
	defer f.Close()

	a := NewClient(ctlPath)
	defer a.Close()
	b := NewClient(ctlPath)
	defer b.Close()
	if err := a.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	if err := b.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatalf("superseding Register: %v", err)
	}
	select {
	case vm := <-p.inUnreg:
		if vm != "vm-1" {
			t.Fatalf("superseded %q", vm)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the stale binding was never unregistered")
	}
	if !p.isBound("vm-1") {
		t.Fatal("vm-1 not bound after supersede")
	}
	// a's later disconnect must not unbind what b now owns.
	_ = a.Close()
	time.Sleep(200 * time.Millisecond)
	if !p.isBound("vm-1") {
		t.Fatal("the superseded connection's disconnect unbound the new owner's VM")
	}
}
