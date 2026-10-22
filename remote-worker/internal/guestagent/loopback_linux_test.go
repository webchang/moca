//go:build linux

package guestagent

import (
	"os"
	"testing"
)

// BringUpLoopback lives in dial_linux.go (upstream's P4.1 egress); guest-agent's main also calls
// it unconditionally at boot. On a host whose lo is already up (any normal machine or CI runner),
// the call must be a no-op that succeeds without privilege: it returns before SIOCSIFFLAGS.
func TestBringUpLoopbackIsANoOpWhenUp(t *testing.T) {
	if _, err := os.Stat("/sys/class/net/lo"); err != nil {
		t.Skip("no lo in this network namespace")
	}
	if b, err := os.ReadFile("/sys/class/net/lo/flags"); err != nil || len(b) == 0 {
		t.Skip("cannot read lo's flags")
	}
	if err := BringUpLoopback(); err != nil {
		t.Fatalf("BringUpLoopback on an up lo: %v", err)
	}
}
