//go:build linux

package guestagent

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// BringUpLoopback sets IFF_UP on the guest's "lo". The guest boots with no init system and no
// network configuration, so nothing else brings it up, and a down lo makes every connect to
// 127.0.0.1 fail with ENETUNREACH even though binding to it succeeds. Test plugins and local
// test servers depend on it (pytest-rerunfailures binds a socket at configure time). The kernel
// assigns 127.0.0.1/8 itself when lo comes up. Interface state is kernel state, so the golden
// snapshot captures it and every restored VM starts with lo up. The guest has no other
// interface; this opens no route off the VM.
func BringUpLoopback() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("loopback: socket: %w", err)
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return fmt.Errorf("loopback: %w", err)
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return fmt.Errorf("loopback: SIOCGIFFLAGS: %w", err)
	}
	flags := ifr.Uint16()
	if flags&unix.IFF_UP != 0 {
		return nil
	}
	ifr.SetUint16(upFlags(flags))
	if err := unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr); err != nil {
		return fmt.Errorf("loopback: SIOCSIFFLAGS: %w", err)
	}
	return nil
}

// upFlags is flags with IFF_UP set and nothing else changed.
func upFlags(flags uint16) uint16 { return flags | unix.IFF_UP }
