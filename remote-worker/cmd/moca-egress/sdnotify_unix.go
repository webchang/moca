//go:build unix

package main

import (
	"fmt"
	"net"
	"os"
)

// sdNotify sends state to systemd's notification socket ($NOTIFY_SOCKET, sd_notify(3)), so a
// Type=notify unit is "started" only once the control socket is bound: the worker, ordered
// After= this unit, then never probes a socket that is not there yet. A no-op without
// NOTIFY_SOCKET (not under systemd). Hand-rolled, as the guest agent's vsock code is, rather
// than adding a dependency for one datagram.
func sdNotify(state string) error {
	addr := os.Getenv("NOTIFY_SOCKET")
	if addr == "" {
		return nil
	}
	if addr[0] == '@' {
		addr = "\x00" + addr[1:] // abstract namespace
	}
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: addr, Net: "unixgram"})
	if err != nil {
		return fmt.Errorf("sd_notify %s: %w", os.Getenv("NOTIFY_SOCKET"), err)
	}
	defer c.Close()
	if _, err := c.Write([]byte(state)); err != nil {
		return fmt.Errorf("sd_notify %s: %w", os.Getenv("NOTIFY_SOCKET"), err)
	}
	return nil
}
