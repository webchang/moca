//go:build !unix

package vmpool

import (
	"errors"
	"runtime"
)

// newEgressBinder refuses: the control client needs unix sockets, and the Firecracker arm
// that uses it only runs on Linux anyway.
func newEgressBinder(string) (EgressBinder, error) {
	return nil, errors.New("egress (MOCA_EGRESS_CONTROL_SOCK) is not supported on " + runtime.GOOS)
}
