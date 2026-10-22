// Package control carries the per-VM listening socket from vmpool to the moca-egress process.
//
// MI1 §8.3 keeps credentials out of the VM-spawning process: vmpool binds the Firecracker
// vsock egress socket (<jail>/run/v.sock_1025) itself, because only it knows the jail
// layout, then hands the listening fd to moca-egress over a Unix control socket as
// SCM_RIGHTS. moca-egress accepts guest connections on that fd without ever touching the
// jail path, and vmpool never sees a grant or a credential.
//
// Wire format: a 4-byte big-endian length followed by a marshalled egressv1.ControlRequest;
// the server answers each request with exactly one framed egressv1.ControlReply, in order.
// A Register's fd rides on the sendmsg that carries the frame's first byte.
//
// The transport is Unix-only (SCM_RIGHTS, peer credentials); on other platforms the package
// holds only the shared types so that importers still compile.
package control

import (
	"fmt"
	"net"
)

// maxFrame bounds a frame body. Control messages are tiny; a larger length means a
// confused or hostile peer, and the stream cannot be resynchronised after it.
const maxFrame = 64 << 10

// Refusal codes carried in ControlReply.Code.
const (
	CodeBadRequest   = "bad_request"
	CodeDuplicateVM  = "duplicate_vm"
	CodeHandlerError = "handler_error"
)

// Handler is the moca-egress side of the channel.
type Handler interface {
	// Register binds vmID's listener. The handler owns ln only when it returns nil; on
	// error the server closes it.
	Register(vmID, sessionID string, grant []byte, ln net.Listener) error
	// Unregister drops vmID's binding. An unknown vmID is not an error.
	Unregister(vmID string) error
}

// RefusalError is a ControlReply{ok:false}. A Handler may return one to choose the code;
// any other handler error is reported as CodeHandlerError.
type RefusalError struct{ Code, Message string }

func (e *RefusalError) Error() string {
	return fmt.Sprintf("egress control refused: %s: %s", e.Code, e.Message)
}
