//go:build unix

package main

import (
	"errors"
	"net/netip"
	"strings"
	"testing"
)

func TestCheckLocalAddrs(t *testing.T) {
	if err := checkLocalAddrs(func() ([]netip.Addr, error) { return nil, nil }); err != nil {
		t.Fatalf("ok path: %v", err)
	}
	boom := errors.New("netlink denied")
	err := checkLocalAddrs(func() ([]netip.Addr, error) { return nil, boom })
	if err == nil || !errors.Is(err, boom) || !strings.Contains(err.Error(), "AF_NETLINK") {
		t.Fatalf("error path: %v", err)
	}
}
