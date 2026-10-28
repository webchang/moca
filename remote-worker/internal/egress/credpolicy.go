package egress

import (
	"bufio"
	"context"
	"net/netip"
	"strings"
	"time"
)

// Header is one header injected into an intercepted request.
type Header struct{ Name, Value string }

// Credential is one element of an owner's credential set for a host.
type Credential struct {
	Name, PathPrefix, Subject string
	Port                      int
	Headers                   []Header
	ExpiresAt                 time.Time // zero: the static resolver
}

// CredentialPolicy looks up the credentials an owner holds for a host. A host
// with any credential on the requested port is never tunnelled or forwarded
// blind (I5): it is intercepted, or refused.
type CredentialPolicy interface {
	// Lookup is called after the allowlist and address checks, once per
	// CONNECT or plain-HTTP request, and again per request inside an
	// intercepted connection. host is normalised (lower case, no trailing
	// dot). The result is the owner's whole set for host, every port and
	// prefix; empty means none. A non-nil error means "unknown": the caller
	// refuses with 503 credential_unavailable and never tunnels.
	Lookup(ctx context.Context, c Caller, host string) ([]Credential, error)
}

// NoCredentials is the policy under which no host has a credential.
type NoCredentials struct{}

// Lookup always returns an empty set.
func (NoCredentials) Lookup(context.Context, Caller, string) ([]Credential, error) {
	return nil, nil
}

// interceptor terminates TLS for a destination that has credentials and
// serves the connection to its end (Task 9). When serve returns, the conn is
// finished.
type interceptor interface {
	serve(pc *proxyConn, t target, addrs []netip.Addr, br *bufio.Reader, ev Event)
}

// forPort keeps the elements whose Port == port.
func forPort(set []Credential, port int) []Credential {
	var out []Credential
	for _, c := range set {
		if c.Port == port {
			out = append(out, c)
		}
	}
	return out
}

// selectFor picks the element with the longest PathPrefix matching path on a
// '/' boundary, or ok=false. set is already forPort-filtered.
func selectFor(set []Credential, path string) (c Credential, ok bool) {
	for _, e := range set {
		if !prefixMatches(e.PathPrefix, path) {
			continue
		}
		if !ok || len(e.PathPrefix) > len(c.PathPrefix) {
			c, ok = e, true
		}
	}
	return c, ok
}

func prefixMatches(prefix, path string) bool {
	if prefix == "/" {
		return strings.HasPrefix(path, "/")
	}
	prefix = strings.TrimSuffix(prefix, "/")
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// pathScoped reports whether any element has a PathPrefix other than "/".
func pathScoped(set []Credential) bool {
	for _, c := range set {
		if c.PathPrefix != "/" {
			return true
		}
	}
	return false
}
