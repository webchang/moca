package egress

import (
	"encoding/json"
	"io"
	"net/url"
	"sync"
	"sync/atomic"
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
	DecisionCredentialInjected    = "credential_injected"
	DecisionCredentialRevoked     = "credential_revoked"
	DecisionPlaintextCredential   = "plaintext_credential"
	DecisionUpstreamUnverified    = "upstream_unverified"
	DecisionMisdirected           = "misdirected_request"
	DecisionLeafUnavailable       = "leaf_unavailable"
	// DecisionAuditDropped reports events an async sink could not queue. It
	// carries no VM: the drops may span VMs, and Dropped says how many.
	DecisionAuditDropped = "audit_dropped"
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
	// Dropped is set only on an audit_dropped event: the number of events lost
	// since the last such report. Omitted everywhere else.
	Dropped uint64 `json:"dropped,omitempty"`
	// Coalesced is set when one event stands for repeats suppressed within an
	// interval: the number suppressed, not counting this one. Omitted when 0.
	Coalesced uint64 `json:"coalesced,omitempty"`
}

// AuditSink receives audit events.
type AuditSink interface{ Emit(Event) }

// CloseAudit flushes and stops s if it buffers events, and is a no-op
// otherwise. Call it after the proxy is closed, so that the last events of
// shutdown — Unregister's aborted events among them — are still written.
func CloseAudit(s AuditSink) error {
	if c, ok := s.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

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

const (
	// defaultAuditQueue is the queue depth of an async sink created with size 0.
	defaultAuditQueue = 4096
	// dropReportEvery bounds how often a non-zero drop count is reported.
	dropReportEvery = 10 * time.Second
)

// asyncSink hands events to inner from one goroutine, so that a stalled writer
// cannot block Emit. It exists because Emit is called on the proxy's hot path
// and under locks a stalled sink would otherwise hold: pc.mu, and through
// abort() the Unregister path and with it the control socket.
//
// A full queue drops rather than blocks — blocking is the failure this type
// exists to prevent — and the loss is reported as an audit_dropped event
// rather than passing silently.
type asyncSink struct {
	inner   AuditSink
	ch      chan Event
	now     func() time.Time
	dropped atomic.Uint64

	done     chan struct{}
	closeOne sync.Once
	stopped  chan struct{}
}

// NewAsyncSink returns a sink that queues up to size events (0 selects a
// default) and forwards them to inner from one goroutine. Emit never blocks:
// once the queue is full, events are counted and dropped, and the count is
// reported as an audit_dropped event. Close flushes what is queued and stops
// the goroutine; it must be called, and may be called more than once.
func NewAsyncSink(inner AuditSink, size int) *asyncSink {
	if size <= 0 {
		size = defaultAuditQueue
	}
	s := &asyncSink{
		inner: inner, ch: make(chan Event, size), now: time.Now,
		done: make(chan struct{}), stopped: make(chan struct{}),
	}
	go s.run()
	return s
}

// Emit queues e, or counts a drop if the queue is full. It never blocks and
// takes no lock, so it is safe to call while holding one.
func (s *asyncSink) Emit(e Event) {
	if e.Time.IsZero() {
		// Stamped here, not in the drain: the queue may delay an event, and the
		// audit trail should say when it happened, not when it was written.
		e.Time = s.now().UTC()
	}
	select {
	case s.ch <- e:
	default:
		s.dropped.Add(1)
	}
}

// run forwards queued events until Close, reporting drops as it goes.
func (s *asyncSink) run() {
	defer close(s.stopped)
	t := time.NewTicker(dropReportEvery)
	defer t.Stop()
	for {
		select {
		case e := <-s.ch:
			s.inner.Emit(e)
		case <-t.C:
			s.reportDrops()
		case <-s.done:
			// Drain what is queued, then report any final loss, so a gap is
			// never left unexplained by a shutdown.
			for {
				select {
				case e := <-s.ch:
					s.inner.Emit(e)
				default:
					s.reportDrops()
					return
				}
			}
		}
	}
}

// reportDrops emits one audit_dropped event if anything was dropped, and
// resets the count. Writing it straight to inner keeps the report itself from
// being the event that overflows the queue.
func (s *asyncSink) reportDrops() {
	n := s.dropped.Swap(0)
	if n == 0 {
		return
	}
	s.inner.Emit(Event{Time: s.now().UTC(), Decision: DecisionAuditDropped, Dropped: n})
}

// Close stops the sink after flushing the queue. It is idempotent, and safe to
// call concurrently with Emit: an Emit racing Close either queues (and is
// flushed) or is counted as a drop (and reported).
func (s *asyncSink) Close() error {
	s.closeOne.Do(func() { close(s.done) })
	<-s.stopped
	return nil
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
