package egress

// CredentialPolicy decides whether a destination needs a credential, which
// this proxy would have to inject by intercepting TLS (MI1 §8.5 item 4). It is
// the seam MI1 S2 fills. This slice has no credentials, so the proxy fails
// closed on any host the policy claims: 503 credential_unavailable, never a
// tunnel and never a dial (I5).
type CredentialPolicy interface {
	Intercept(c Caller, host string) bool
}

// NoCredentials is the policy of this slice: no host needs a credential.
type NoCredentials struct{}

// Intercept always reports false.
func (NoCredentials) Intercept(Caller, string) bool { return false }
