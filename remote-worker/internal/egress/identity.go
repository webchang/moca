package egress

import (
	"errors"
	"net"
)

// Caller is who a guest connection belongs to. It comes from the listener the
// connection was accepted on (MI1 I3, P4.1 T4), never from the request.
type Caller struct{ VMID, SessionID, Subject string }

// CallerIdentity resolves an accepted connection to its caller. It reports
// false when the connection carries no binding.
type CallerIdentity interface {
	Identify(c net.Conn) (Caller, bool)
}

// boundConn is a connection accepted on a registered per-VM listener. The
// caller is attached at accept time by the proxy's serve loop and is the only
// identity source: no header can set or change it.
type boundConn struct {
	net.Conn
	caller Caller
}

// CloseWrite half-closes the underlying connection when it supports that.
func (b *boundConn) CloseWrite() error {
	if cw, ok := b.Conn.(closeWriter); ok {
		return cw.CloseWrite()
	}
	return errors.ErrUnsupported
}

// socketIdentity is the one CallerIdentity of this slice (doc.go): it reads
// the binding the per-VM listener attached.
type socketIdentity struct{}

func (socketIdentity) Identify(c net.Conn) (Caller, bool) {
	b, ok := c.(*boundConn)
	if !ok {
		return Caller{}, false
	}
	return b.caller, true
}
