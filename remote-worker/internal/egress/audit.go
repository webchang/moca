package egress

import (
	"encoding/json"
	"io"
	"net/url"
	"sync"
	"time"
)

// Decision values recorded in Event.Decision.
const (
	DecisionTunnel                = "tunnel"
	DecisionForward               = "forward"
	DecisionDestinationDenied     = "destination_denied"
	DecisionDestinationPrivate    = "destination_private"
	DecisionConnCap               = "conn_cap"
	DecisionRequestCap            = "request_cap"
	DecisionNoBinding             = "no_binding"
	DecisionCredentialUnavailable = "credential_unavailable"
	DecisionUpstreamUnreachable   = "upstream_unreachable"
	DecisionBadRequest            = "bad_request"
	DecisionAborted               = "aborted"
)

// viaName is the fixed value of Event.Via.
const viaName = "moca-egress"

// Event is one audit record. Path carries no query string, fragment or
// userinfo (see RedactPath); Credential is a name, never a value.
type Event struct {
	Time       time.Time `json:"time"`
	Via        string    `json:"via"`
	VMID       string    `json:"vm_id"`
	SID        string    `json:"sid"`
	Sub        string    `json:"sub,omitempty"`
	Host       string    `json:"host"`
	DialAddr   string    `json:"dial_addr,omitempty"`
	Method     string    `json:"method"`
	Path       string    `json:"path,omitempty"`
	Status     int       `json:"status"`
	BytesUp    int64     `json:"bytes_up"`
	BytesDown  int64     `json:"bytes_down"`
	Credential string    `json:"credential,omitempty"`
	Decision   string    `json:"decision"`
}

// AuditSink receives audit events.
type AuditSink interface{ Emit(Event) }

type jsonSink struct {
	mu  sync.Mutex
	enc *json.Encoder
}

// NewJSONSink returns a sink writing one JSON line per event to w. Via is
// forced to "moca-egress" and a zero Time is filled with the current UTC time.
// Write errors are ignored.
func NewJSONSink(w io.Writer) AuditSink {
	return &jsonSink{enc: json.NewEncoder(w)}
}

func (s *jsonSink) Emit(e Event) {
	e.Via = viaName
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.enc.Encode(e) // write errors are deliberately ignored: auditing must not stall the proxy
}

// RedactPath returns the escaped path of u and nothing else: no query,
// fragment or userinfo. An empty path or nil u yields "/".
func RedactPath(u *url.URL) string {
	if u == nil {
		return "/"
	}
	if p := u.EscapedPath(); p != "" {
		return p
	}
	return "/"
}
