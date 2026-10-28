package egress

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRedactPathDropsQueryFragmentUserinfo(t *testing.T) {
	u, _ := url.Parse("http://u:p@h/a%20b?token=s#f")
	if got := RedactPath(u); got != "/a%20b" {
		t.Fatalf("got %q", got)
	}
	u2, _ := url.Parse("http://h")
	if got := RedactPath(u2); got != "/" {
		t.Fatalf("got %q", got)
	}
	for in, want := range map[string]string{
		"http://h/a%3Fb?x=1": "/a%3Fb",
		"http://h/p?":        "/p",
		"mailto:a@b?s=t":     "/",
	} {
		u, err := url.Parse(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := RedactPath(u); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
	if got := RedactPath(nil); got != "/" {
		t.Fatalf("nil: got %q", got)
	}
}

func TestJSONSinkWritesOneLinePerEvent(t *testing.T) {
	var b bytes.Buffer
	s := NewJSONSink(&b)
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "a.com", Method: "CONNECT", Status: 200, Decision: DecisionTunnel, Via: "spoof"})
	s.Emit(Event{VMID: "vm1", SID: "s1", Host: "b.com", Method: "GET", Path: "/x", Decision: DecisionForward})
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines=%d: %q", len(lines), b.String())
	}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("%q: %v", l, err)
		}
		if m["via"] != "moca-egress" {
			t.Fatalf("via=%v", m["via"])
		}
		if m["time"] == "0001-01-01T00:00:00Z" {
			t.Fatal("time not filled")
		}
	}
}

// blockingSink parks every Emit until release is closed, standing in for a
// journald that has stopped reading.
type blockingSink struct {
	release chan struct{}
	mu      sync.Mutex
	seen    []Event
}

func (b *blockingSink) Emit(e Event) {
	<-b.release
	b.mu.Lock()
	b.seen = append(b.seen, e)
	b.mu.Unlock()
}

func (b *blockingSink) events() []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Event(nil), b.seen...)
}

// countingSink records events without blocking.
type countingSink struct {
	mu   sync.Mutex
	seen []Event
}

func (c *countingSink) Emit(e Event) {
	c.mu.Lock()
	c.seen = append(c.seen, e)
	c.mu.Unlock()
}

func (c *countingSink) events() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Event(nil), c.seen...)
}

func TestAsyncSinkForwardsEveryEventInOrder(t *testing.T) {
	inner := &countingSink{}
	s := NewAsyncSink(inner, 16)
	for i := 0; i < 10; i++ {
		s.Emit(Event{Host: "h", Path: strconv.Itoa(i), Decision: DecisionForward})
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := inner.events()
	if len(got) != 10 {
		t.Fatalf("forwarded %d events, want 10", len(got))
	}
	for i, e := range got {
		if e.Path != strconv.Itoa(i) {
			t.Fatalf("event %d has path %q: order not preserved", i, e.Path)
		}
		if e.Time.IsZero() {
			t.Fatalf("event %d has no time", i)
		}
	}
}

// TestAsyncSinkEmitDoesNotBlockOnAStalledInnerSink is the assertion for #586's
// second defect: Emit is called under pc.mu and from abort() via Unregister, so
// an Emit that waits on the writer stalls the control socket. Making Emit
// synchronous again must fail here.
func TestAsyncSinkEmitDoesNotBlockOnAStalledInnerSink(t *testing.T) {
	inner := &blockingSink{release: make(chan struct{})}
	s := NewAsyncSink(inner, 4)

	done := make(chan struct{})
	go func() {
		defer close(done)
		// More events than the queue holds: past it they are dropped, never
		// blocked, so every one of these calls must return.
		for i := 0; i < 50; i++ {
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Emit blocked on a stalled sink: the proxy's hot path and Unregister would stall with it")
	}

	close(inner.release)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestAsyncSinkDropsAndReportsTheCountOnClose(t *testing.T) {
	inner := &blockingSink{release: make(chan struct{})}
	s := NewAsyncSink(inner, 2)
	const n = 40
	for i := 0; i < n; i++ {
		s.Emit(Event{Host: "h", Decision: DecisionTunnel})
	}
	close(inner.release)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	var forwarded, dropReports int
	var reported uint64
	for _, e := range inner.events() {
		if e.Decision == DecisionAuditDropped {
			dropReports++
			reported += e.Dropped
			if e.VMID != "" {
				t.Fatalf("audit_dropped names vm %q: drops may span VMs", e.VMID)
			}
			continue
		}
		forwarded++
	}
	if dropReports == 0 {
		t.Fatal("events were dropped but no audit_dropped event was emitted: the gap is silent")
	}
	if forwarded == 0 {
		t.Fatal("nothing was forwarded at all")
	}
	if forwarded+int(reported) != n {
		t.Fatalf("forwarded %d + dropped %d != %d emitted: the count does not account for the gap",
			forwarded, reported, n)
	}
}

func TestAsyncSinkCloseIsIdempotent(t *testing.T) {
	s := NewAsyncSink(&countingSink{}, 4)
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestAsyncSinkEmitAfterCloseDoesNotPanicOrBlock covers the shutdown race: the
// proxy's goroutines may still emit while main is closing the sink.
func TestAsyncSinkEmitAfterCloseDoesNotPanicOrBlock(t *testing.T) {
	s := NewAsyncSink(&countingSink{}, 1)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 10; i++ {
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Emit blocked after Close")
	}
}

func TestAsyncSinkConcurrentEmitAndClose(t *testing.T) {
	inner := &countingSink{}
	s := NewAsyncSink(inner, 8)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}()
	}
	wg.Wait()
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	var seen int
	for _, e := range inner.events() {
		if e.Decision == DecisionAuditDropped {
			seen += int(e.Dropped)
			continue
		}
		seen++
	}
	if seen != 50 {
		t.Fatalf("accounted for %d of 50 events", seen)
	}
}

// TestCloseAuditIsANoOpOnAPlainSink keeps main's shutdown honest for a sink
// that does not buffer.
func TestCloseAuditIsANoOpOnAPlainSink(t *testing.T) {
	if err := CloseAudit(NewJSONSink(&bytes.Buffer{})); err != nil {
		t.Fatalf("CloseAudit on a jsonSink: %v", err)
	}
	if err := CloseAudit(&countingSink{}); err != nil {
		t.Fatalf("CloseAudit on a non-closer: %v", err)
	}
	s := NewAsyncSink(&countingSink{}, 2)
	if err := CloseAudit(s); err != nil {
		t.Fatalf("CloseAudit on an asyncSink: %v", err)
	}
}

func TestJSONSinkConcurrentEmit(t *testing.T) {
	var b bytes.Buffer
	s := NewJSONSink(&b)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Emit(Event{Host: "h", Decision: DecisionTunnel})
		}()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 50 {
		t.Fatalf("lines=%d", len(lines))
	}
	for _, l := range lines {
		if !json.Valid([]byte(l)) {
			t.Fatalf("invalid line %q", l)
		}
	}
}
