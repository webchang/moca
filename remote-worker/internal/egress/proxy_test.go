//go:build unix

package egress

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// recSink records events and their JSON form; safe for concurrent use.
type recSink struct {
	mu  sync.Mutex
	evs []Event
	js  bytes.Buffer
}

func (s *recSink) Emit(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evs = append(s.evs, e)
	b, _ := json.Marshal(e)
	s.js.Write(b)
	s.js.WriteByte('\n')
}

func (s *recSink) events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.evs...)
}

func (s *recSink) jsonText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.js.String()
}

// waitEvent polls until an event with the decision appears.
func (s *recSink) waitEvent(t *testing.T, decision string) Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range s.events() {
			if e.Decision == decision {
				return e
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no %q event; have %+v", decision, s.events())
	return Event{}
}

// mapResolver answers from a table; fn, when set, overrides it per call.
type mapResolver struct {
	mu    sync.Mutex
	m     map[string][]netip.Addr
	fn    map[string]func(call int) []netip.Addr
	calls map[string]int
}

func newResolver() *mapResolver {
	return &mapResolver{m: map[string][]netip.Addr{}, fn: map[string]func(int) []netip.Addr{}, calls: map[string]int{}}
}

func (r *mapResolver) set(host string, addrs ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var as []netip.Addr
	for _, a := range addrs {
		as = append(as, netip.MustParseAddr(a))
	}
	r.m[host] = as
}

func (r *mapResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls[host]++
	if f := r.fn[host]; f != nil {
		return f(r.calls[host]), nil
	}
	if as, ok := r.m[host]; ok {
		return as, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func (r *mapResolver) count(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[host]
}

// tcpUpstream is a raw TCP listener on 127.0.0.1 counting accepts.
type tcpUpstream struct {
	ln      net.Listener
	accepts atomic.Int64
	port    int
}

func newTCPUpstream(t *testing.T, handle func(net.Conn)) *tcpUpstream {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	u := &tcpUpstream{ln: ln, port: ln.Addr().(*net.TCPAddr).Port}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			u.accepts.Add(1)
			go handle(c)
		}
	}()
	return u
}

func echo(c net.Conn) { defer c.Close(); io.Copy(c, c) }

// httpUpstream is an httptest server on 127.0.0.1 recording requests.
type httpUpstream struct {
	srv     *httptest.Server
	port    int
	accepts atomic.Int64
	mu      sync.Mutex
	reqs    []*http.Request
}

func newHTTPUpstream(t *testing.T) *httpUpstream {
	t.Helper()
	u := &httpUpstream{}
	u.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.reqs = append(u.reqs, r)
		u.mu.Unlock()
		w.Header().Set("X-Moca-Egress-Error", "spoofed")
		fmt.Fprintf(w, "hello %s", r.URL.RawQuery)
	}))
	u.srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			u.accepts.Add(1)
		}
	}
	u.srv.Start()
	t.Cleanup(u.srv.Close)
	u.port = u.srv.Listener.Addr().(*net.TCPAddr).Port
	return u
}

func (u *httpUpstream) last(t *testing.T) *http.Request {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.reqs) == 0 {
		t.Fatal("upstream saw no request")
	}
	return u.reqs[len(u.reqs)-1]
}

type stubCreds map[string]bool

func (s stubCreds) Intercept(_ Caller, host string) bool { return s[host] }

type harness struct {
	t    *testing.T
	p    *Proxy
	sink *recSink
	res  *mapResolver
	dir  string
}

func allow(t *testing.T, s string) []AllowEntry {
	t.Helper()
	a, err := ParseAllow(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func newHarness(t *testing.T, allowList string, mod func(*Config)) *harness {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "eg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	h := &harness{t: t, sink: &recSink{}, res: newResolver(), dir: dir}
	cfg := Config{
		Allow:                 allow(t, allowList),
		PermitCIDRs:           []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")},
		MaxConnsPerVM:         8,
		MaxRequestsPerSession: 1000,
		Resolver:              h.res,
		Credentials:           NoCredentials{},
		Audit:                 h.sink,
		DialTimeout:           2 * time.Second,
	}
	if mod != nil {
		mod(&cfg)
	}
	p, err := NewProxy(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	h.p = p
	return h
}

// register binds a fresh unix listener for vmID/sid and returns its path.
func (h *harness) register(vmID, sid string) string {
	h.t.Helper()
	path := filepath.Join(h.dir, vmID+".sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		h.t.Fatal(err)
	}
	if err := h.p.Register(vmID, sid, nil, ln); err != nil {
		ln.Close()
		h.t.Fatal(err)
	}
	return path
}

func dial(t *testing.T, path string) *net.UnixConn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	return c.(*net.UnixConn)
}

const established = "HTTP/1.1 200 Connection Established\r\n\r\n"

// connect sends CONNECT target and asserts the exact 200 line.
func connect(t *testing.T, c net.Conn, target string) {
	t.Helper()
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	buf := make([]byte, len(established))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != established {
		t.Fatalf("CONNECT reply %q, %v", buf, err)
	}
}

// roundTrip writes raw and reads one response.
func roundTrip(t *testing.T, c net.Conn, raw string) (*http.Response, string) {
	t.Helper()
	if _, err := io.WriteString(c, raw); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func assertRefusal(t *testing.T, resp *http.Response, body string, status int, code, host string) {
	t.Helper()
	if resp.StatusCode != status {
		t.Fatalf("status %d, want %d (body %q)", resp.StatusCode, status, body)
	}
	if got := resp.Header.Get("X-Moca-Egress-Error"); got != code {
		t.Fatalf("X-Moca-Egress-Error %q, want %q", got, code)
	}
	if want := code + ": " + host + "\n"; body != want {
		t.Fatalf("body %q, want %q", body, want)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("content-type %q", ct)
	}
}

func TestConnectTunnelsToAnAllowlistedHost(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo %q, %v", buf, err)
	}
	c.Close()
	e := h.sink.waitEvent(t, DecisionTunnel)
	if e.SID != "run-a" || e.VMID != "vm-1" || e.DialAddr != fmt.Sprintf("127.0.0.1:%d", up.port) ||
		e.Status != 200 || e.BytesUp != 4 || e.BytesDown != 4 || e.Host != "up.test" || e.Method != "CONNECT" {
		t.Fatalf("event %+v", e)
	}
	if n := len(h.sink.events()); n != 1 {
		t.Fatalf("%d events, want 1: %+v", n, h.sink.events())
	}
}

func TestIdentityComesFromTheAcceptingSocket(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	h.register("vm-1", "run-a")
	c := dial(t, h.register("vm-2", "run-b"))
	resp, body := roundTrip(t, c, fmt.Sprintf("GET http://up.test:%d/x HTTP/1.1\r\nHost: up.test:%d\r\n"+
		"X-Moca-Session: run-a\r\nx-moca-vm: vm-1\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n"+
		"Proxy-Connection: keep-alive\r\nProxy-Tenant: other\r\nproxy-remote-user: root\r\n\r\n", up.port, up.port))
	if resp.StatusCode != 200 || body != "hello " {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Moca-Egress-Error") != "" {
		t.Fatal("upstream X-Moca-* header leaked to the guest")
	}
	r := up.last(t)
	for k := range r.Header {
		if lk := strings.ToLower(k); strings.HasPrefix(lk, "x-moca-") || strings.HasPrefix(lk, "proxy-") {
			t.Fatalf("upstream saw %s", k)
		}
	}
	e := h.sink.waitEvent(t, DecisionForward)
	if e.SID != "run-b" || e.VMID != "vm-2" {
		t.Fatalf("identity from headers: %+v", e)
	}
}

func TestOffAllowlistIsANamed403(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("evil.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	resp, body := roundTrip(t, c, fmt.Sprintf("CONNECT evil.test:%d HTTP/1.1\r\nHost: evil.test\r\n\r\n", up.port))
	assertRefusal(t, resp, body, 403, DecisionDestinationDenied, "evil.test")
	if up.accepts.Load() != 0 || h.res.count("evil.test") != 0 {
		t.Fatal("refused destination was resolved or dialed")
	}
	if e := h.sink.waitEvent(t, DecisionDestinationDenied); e.Status != 403 || e.Host != "evil.test" {
		t.Fatalf("event %+v", e)
	}
}

func TestPrivateAnswerIsRefused(t *testing.T) {
	h := newHarness(t, "priv.test:443,169.254.169.254:80", nil)
	h.res.set("priv.test", "127.0.0.1", "10.0.0.5")
	path := h.register("vm-1", "run-a")
	resp, body := roundTrip(t, dial(t, path), "CONNECT priv.test:443 HTTP/1.1\r\nHost: priv.test\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "priv.test")
	resp, body = roundTrip(t, dial(t, path), "CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "169.254.169.254")
	resp, body = roundTrip(t, dial(t, path), "GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n")
	assertRefusal(t, resp, body, 403, DecisionDestinationPrivate, "169.254.169.254")
	if h.res.count("169.254.169.254") != 0 {
		t.Fatal("IP literal went to DNS")
	}
}

func TestResolvesOnceAndDialsTheCheckedAddress(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.fn["up.test"] = func(call int) []netip.Addr {
		if call == 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}
		}
		return []netip.Addr{netip.MustParseAddr("10.0.0.9")}
	}
	c := dial(t, h.register("vm-1", "run-a"))
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	c.Write([]byte("x"))
	b := make([]byte, 1)
	if _, err := io.ReadFull(c, b); err != nil || b[0] != 'x' {
		t.Fatalf("%q %v", b, err)
	}
	if n := h.res.count("up.test"); n != 1 {
		t.Fatalf("resolver called %d times", n)
	}
}

func TestPerVMConnCap(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxConnsPerVM = 2 })
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	for i := 0; i < 2; i++ {
		connect(t, dial(t, path), fmt.Sprintf("up.test:%d", up.port))
	}
	// The third guest pipelines its CONNECT before reading: it must see the
	// named 429, not a reset from closing with unread input.
	c3 := dial(t, path)
	fmt.Fprintf(c3, "CONNECT up.test:%d HTTP/1.1\r\nHost: up.test\r\n\r\n%s", up.port, strings.Repeat("x", 8192))
	resp, err := http.ReadResponse(bufio.NewReader(c3), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	assertRefusal(t, resp, string(body), 429, DecisionConnCap, "vm-1")
	h.sink.waitEvent(t, DecisionConnCap)
}

func TestPerSessionRequestCap(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), func(c *Config) { c.MaxRequestsPerSession = 3 })
	h.res.set("up.test", "127.0.0.1")
	paths := []string{h.register("vm-1", "run-a"), h.register("vm-2", "run-a")}
	req := fmt.Sprintf("GET http://up.test:%d/ HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port)
	for i := 0; i < 3; i++ {
		resp, body := roundTrip(t, dial(t, paths[i%2]), req)
		if resp.StatusCode != 200 {
			t.Fatalf("request %d: %d %q", i, resp.StatusCode, body)
		}
	}
	resp, body := roundTrip(t, dial(t, paths[1]), req)
	assertRefusal(t, resp, body, 429, DecisionRequestCap, "up.test")
}

func TestUnregisterAbortsInFlightTunnels(t *testing.T) {
	up := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	c := dial(t, path)
	connect(t, c, fmt.Sprintf("up.test:%d", up.port))
	if err := h.p.Unregister("vm-1"); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("client not closed: %v", err)
	}
	h.sink.waitEvent(t, DecisionAborted)
	time.Sleep(50 * time.Millisecond)
	for _, e := range h.sink.events() {
		if e.Decision == DecisionTunnel {
			t.Fatalf("aborted tunnel also logged as tunnel: %+v", h.sink.events())
		}
	}
	if n := len(h.sink.events()); n != 1 {
		t.Fatalf("%d events: %+v", n, h.sink.events())
	}
	if c2, err := net.Dial("unix", path); err == nil {
		c2.Close()
		t.Fatal("socket still accepts after Unregister")
	}
	if err := h.p.Unregister("vm-unknown"); err != nil {
		t.Fatal(err)
	}
}

func TestPlainHTTPForwardsWithoutCredentialsAndRedactsQuery(t *testing.T) {
	up := newHTTPUpstream(t)
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	req := fmt.Sprintf("GET http://up.test:%d/p?token=s3cret HTTP/1.1\r\nHost: up.test:%d\r\n\r\n", up.port, up.port)
	// Two requests on one keep-alive conn; each is checked and audited.
	br := bufio.NewReader(c)
	for i := 0; i < 2; i++ {
		io.WriteString(c, req)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(b) != "hello token=s3cret" {
			t.Fatalf("%d %q", resp.StatusCode, b)
		}
	}
	r := up.last(t)
	if r.URL.RawQuery != "token=s3cret" || r.Header.Get("Authorization") != "" {
		t.Fatalf("upstream got %q auth=%q", r.URL.RawQuery, r.Header.Get("Authorization"))
	}
	if r.Host != fmt.Sprintf("up.test:%d", up.port) {
		t.Fatalf("upstream Host %q", r.Host)
	}
	e := h.sink.waitEvent(t, DecisionForward)
	if e.Path != "/p" || e.Status != 200 || e.DialAddr != "127.0.0.1:"+strconv.Itoa(up.port) || e.BytesDown == 0 {
		t.Fatalf("event %+v", e)
	}
	if n := h.res.count("up.test"); n != 2 {
		t.Fatalf("each request must re-resolve; resolver called %d times", n)
	}
	if strings.Contains(h.sink.jsonText(), "s3cret") {
		t.Fatal("audit leaked the query string")
	}
}

func TestHostThatNeedsACredentialFailsClosed(t *testing.T) {
	up := newHTTPUpstream(t)
	tcp := newTCPUpstream(t, echo)
	h := newHarness(t, fmt.Sprintf("up.test:%d,up.test:%d", up.port, tcp.port), func(c *Config) {
		c.Credentials = stubCreds{"up.test": true}
	})
	h.res.set("up.test", "127.0.0.1")
	path := h.register("vm-1", "run-a")
	resp, body := roundTrip(t, dial(t, path), fmt.Sprintf("CONNECT up.test:%d HTTP/1.1\r\n\r\n", tcp.port))
	assertRefusal(t, resp, body, 503, DecisionCredentialUnavailable, "up.test")
	resp, body = roundTrip(t, dial(t, path), fmt.Sprintf("GET http://up.test:%d/ HTTP/1.1\r\nHost: up.test\r\n\r\n", up.port))
	assertRefusal(t, resp, body, 503, DecisionCredentialUnavailable, "up.test")
	if up.accepts.Load() != 0 || tcp.accepts.Load() != 0 {
		t.Fatal("a credentialed host was dialed")
	}
}

func TestTunnelPropagatesHalfClose(t *testing.T) {
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		b, _ := io.ReadAll(c) // only returns on EOF
		if string(b) == "req" {
			c.Write([]byte("resp"))
		}
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	// "req" rides in the same write as CONNECT: bytes buffered behind the
	// request line must reach the upstream first.
	fmt.Fprintf(c, "CONNECT up.test:%d HTTP/1.1\r\n\r\nreq", up.port)
	c.CloseWrite()
	b, err := io.ReadAll(c)
	if err != nil || string(b) != established+"resp" {
		t.Fatalf("got %q, %v", b, err)
	}
	if e := h.sink.waitEvent(t, DecisionTunnel); e.BytesUp != 3 || e.BytesDown != 4 {
		t.Fatalf("event %+v", e)
	}
}

func TestRegisterRefusesAGrant(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(h.dir, "g.sock"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	err = h.p.Register("vm-1", "run-a", []byte("grant"), ln)
	var re *control.RefusalError
	if !errors.As(err, &re) || re.Code != control.CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	h.register("vm-1", "run-a")
	ln2, _ := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(h.dir, "d.sock"), Net: "unix"})
	defer ln2.Close()
	if err := h.p.Register("vm-1", "run-b", nil, ln2); !errors.As(err, &re) || re.Code != control.CodeDuplicateVM {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestNonProxyRequestIs400(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	path := h.register("vm-1", "run-a")
	resp, body := roundTrip(t, dial(t, path), "GET /x HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
	resp, body = roundTrip(t, dial(t, path), "GET https://up.test/x HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
	resp, body = roundTrip(t, dial(t, path), "CONNECT up.test HTTP/1.1\r\nHost: up.test\r\n\r\n")
	assertRefusal(t, resp, body, 400, DecisionBadRequest, "up.test")
}

func TestNewProxyValidatesConfig(t *testing.T) {
	good := Config{
		Allow: allow(t, "up.test"), MaxConnsPerVM: 1, MaxRequestsPerSession: 1,
		Resolver: newResolver(), Credentials: NoCredentials{}, Audit: &recSink{},
	}
	for name, mod := range map[string]func(*Config){
		"allow": func(c *Config) { c.Allow = nil }, "resolver": func(c *Config) { c.Resolver = nil },
		"audit": func(c *Config) { c.Audit = nil }, "creds": func(c *Config) { c.Credentials = nil },
		"conns": func(c *Config) { c.MaxConnsPerVM = 0 }, "reqs": func(c *Config) { c.MaxRequestsPerSession = -1 },
	} {
		c := good
		mod(&c)
		if _, err := NewProxy(c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	p, err := NewProxy(good)
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
}

func TestUpstream101IsRefused(t *testing.T) {
	// The upstream answers 101 although the proxy stripped Upgrade; the raw
	// stream after it must never reach the guest.
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		http.ReadRequest(bufio.NewReader(c))
		io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nRAWSTREAM")
		time.Sleep(200 * time.Millisecond)
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	io.WriteString(c, fmt.Sprintf("GET http://up.test:%d/ws HTTP/1.1\r\nHost: up.test\r\n"+
		"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n", up.port))
	all, _ := io.ReadAll(c)
	if strings.Contains(string(all), "RAWSTREAM") || strings.Contains(string(all), " 101 ") {
		t.Fatalf("101 stream relayed: %q", all)
	}
	resp, err := http.ReadResponse(bufio.NewReader(strings.NewReader(string(all))), nil)
	if err != nil {
		t.Fatalf("%v: %q", err, all)
	}
	body, _ := io.ReadAll(resp.Body)
	assertRefusal(t, resp, string(body), 502, DecisionUpstreamUnreachable, "up.test")
	h.sink.waitEvent(t, DecisionUpstreamUnreachable)
	for _, e := range h.sink.events() {
		if e.Decision == DecisionForward {
			t.Fatalf("101 audited as forward: %+v", e)
		}
	}
}

func TestTrailersAreScrubbedBothWays(t *testing.T) {
	var upHdr, upTrailer http.Header
	var mu sync.Mutex
	up := newTCPUpstream(t, func(c net.Conn) {
		defer c.Close()
		br := bufio.NewReader(c)
		r, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		io.ReadAll(r.Body)
		mu.Lock()
		upHdr, upTrailer = r.Header.Clone(), r.Trailer.Clone()
		mu.Unlock()
		io.WriteString(c, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"+
			"Trailer: X-Moca-Leak, Proxy-Authenticate, Connection, X-Fine\r\n\r\n"+
			"2\r\nok\r\n0\r\nX-Moca-Leak: up\r\nProxy-Authenticate: up\r\nConnection: up\r\nX-Fine: yes\r\n\r\n")
	})
	h := newHarness(t, fmt.Sprintf("up.test:%d", up.port), nil)
	h.res.set("up.test", "127.0.0.1")
	c := dial(t, h.register("vm-1", "run-a"))
	io.WriteString(c, fmt.Sprintf("POST http://up.test:%d/t HTTP/1.1\r\nHost: up.test\r\n"+
		"Transfer-Encoding: chunked\r\nTrailer: X-Moca-Session, Proxy-Authorization, X-Ok\r\n\r\n"+
		"3\r\nabc\r\n0\r\nX-Moca-Session: run-a\r\nProxy-Authorization: Basic Zm9v\r\nX-Ok: 1\r\n\r\n", up.port))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) != "ok" {
		t.Fatalf("%d %q", resp.StatusCode, b)
	}
	for k := range resp.Trailer {
		if k != "X-Fine" {
			t.Fatalf("guest got response trailer %s: %v", k, resp.Trailer)
		}
	}
	if resp.Trailer.Get("X-Fine") != "yes" {
		t.Fatalf("benign response trailer lost: %v", resp.Trailer)
	}
	mu.Lock()
	defer mu.Unlock()
	if upHdr == nil {
		t.Fatal("upstream saw no request")
	}
	if v := upHdr.Get("Trailer"); v != "" {
		t.Fatalf("upstream got Trailer header %q", v)
	}
	for k := range upTrailer {
		t.Fatalf("upstream got request trailer %s: %v", k, upTrailer)
	}
}

// stuckListener reports a non-ErrClosed error from Accept once closed, as a
// misbehaving listener implementation might.
type stuckListener struct {
	closed chan struct{}
	once   sync.Once
}

func (l *stuckListener) Accept() (net.Conn, error) {
	<-l.closed
	return nil, errors.New("listener gone")
}
func (l *stuckListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *stuckListener) Addr() net.Addr { return &net.UnixAddr{Name: "stuck", Net: "unix"} }

func TestCloseReturnsWhenAcceptKeepsFailing(t *testing.T) {
	h := newHarness(t, "up.test", nil)
	if err := h.p.Register("vm-1", "run-a", nil, &stuckListener{closed: make(chan struct{})}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- h.p.Close() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close hung: serve spins on a non-ErrClosed accept error")
	}
}
