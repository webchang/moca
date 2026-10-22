//go:build linux || darwin

package control

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a bytes.Buffer safe to share between the log package and the test.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// A heal that succeeds on its first redial must still say so. After `systemctl restart
// moca-egress` that is the usual case, and the line is the worker journal's only record that
// live VMs were re-registered -- the nested-m8i live run found the journal silent.
func TestHealLogsAFirstTryReconnect(t *testing.T) {
	var buf syncBuffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	dir := shortDir(t)
	ctlPath := filepath.Join(dir, "c.sock")
	h1 := newRecorder()
	h1.closeOnUnregister = true
	s1 := startServer(t, ctlPath, []int{os.Getuid()}, h1)
	c := NewClient(ctlPath)
	defer c.Close()

	_, _, f := vmListener(t, dir, "vm.sock")
	if err := c.Register(ctx(t), "vm-1", "run-a", nil, f); err != nil {
		t.Fatal(err)
	}
	recv(t, h1.regs)

	// The replacement server is up before the client notices the old one is gone, so the
	// first redial succeeds: failures stays 0.
	h2 := newRecorder()
	s1.Close()
	startServer(t, ctlPath, []int{os.Getuid()}, h2)
	recvWithin(t, h2.regs, 2500*time.Millisecond, "the automatic replay")

	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(buf.String(), "replayed 1 registrations") {
		if time.Now().After(deadline) {
			t.Fatalf("no reconnect line after a first-try heal; log was:\n%s", buf.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(buf.String(), "after 0 failed attempts") {
		t.Errorf("expected a first-try heal (0 failed attempts); log was:\n%s", buf.String())
	}
}
