//go:build linux

package guestagent

import (
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func TestUpFlagsSetsOnlyIFFUp(t *testing.T) {
	for _, f := range []uint16{0, unix.IFF_LOOPBACK, unix.IFF_LOOPBACK | unix.IFF_RUNNING, unix.IFF_UP | unix.IFF_LOOPBACK} {
		got := upFlags(f)
		if got&unix.IFF_UP == 0 {
			t.Errorf("upFlags(%#x) = %#x: IFF_UP not set", f, got)
		}
		if got&^unix.IFF_UP != f&^unix.IFF_UP {
			t.Errorf("upFlags(%#x) = %#x: changed a flag other than IFF_UP", f, got)
		}
	}
}

// On a host whose lo is already up (any normal machine or CI runner), the call must be a
// no-op that succeeds without privilege: it returns before SIOCSIFFLAGS.
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
