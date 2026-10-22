//go:build unix

package vmpool

import "github.com/rossoctl/moca/remote-worker/internal/egress/control"

var _ EgressBinder = (*control.Client)(nil)

// newEgressBinder dials nothing yet: control.Client connects lazily on first Register.
func newEgressBinder(controlSock string) (EgressBinder, error) {
	return control.NewClient(controlSock), nil
}
