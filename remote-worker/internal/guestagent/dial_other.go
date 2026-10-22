//go:build !linux

package guestagent

import (
	"fmt"
	"net"
)

// DialVsock is Linux-only: vsock does not exist elsewhere (spec §5.1).
func DialVsock(cid, port uint32) (net.Conn, error) {
	return nil, fmt.Errorf("guestagent: vsock dial %d:%d is Linux-only", cid, port)
}

// BringUpLoopback is a no-op off Linux; the host's loopback is already up.
func BringUpLoopback() error { return nil }
