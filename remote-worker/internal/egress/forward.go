package egress

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"strings"
	"sync/atomic"
	"time"
)

// hopHeaders are removed in both directions (RFC 9110 §7.6.1), together with
// whatever the Connection header names.
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// scrubHeaders removes hop-by-hop headers, the headers Connection names, and
// every Proxy-* and X-Moca-* header, in either direction. Proxy-* goes by prefix,
// not only the hop-by-hop Proxy-Authorization/-Connection/-Authenticate: a
// guest's Proxy-Tenant or Proxy-Remote-User must not reach an upstream that might
// trust it, and the conformance contract (egress/conformance) promises the
// prefix. Nothing is added.
func scrubHeaders(h http.Header) {
	for _, v := range h["Connection"] {
		for _, f := range strings.Split(v, ",") {
			if f = textproto.TrimString(f); f != "" {
				h.Del(f)
			}
		}
	}
	for _, k := range hopHeaders {
		h.Del(k)
	}
	for k := range h {
		if lk := strings.ToLower(k); strings.HasPrefix(lk, "x-moca-") || strings.HasPrefix(lk, "proxy-") {
			delete(h, k)
		}
	}
}

// countingBody counts the bytes read through it.
type countingBody struct {
	io.ReadCloser
	n *atomic.Int64
}

func (c countingBody) Read(b []byte) (int, error) {
	n, err := c.ReadCloser.Read(b)
	c.n.Add(int64(n))
	return n, err
}

// scrubTrailer removes from a trailer exactly what scrubHeaders removes from a
// header.
func scrubTrailer(t http.Header) { scrubHeaders(t) }

// trailerScrubBody scrubs resp.Trailer once the upstream body hits EOF,
// which is when the Transport fills in trailer values.
type trailerScrubBody struct {
	countingBody
	resp *http.Response
}

func (b trailerScrubBody) Read(p []byte) (int, error) {
	n, err := b.countingBody.Read(p)
	if err == io.EOF {
		scrubTrailer(b.resp.Trailer)
	}
	return n, err
}

// keptBody is the guest's request body as handed to the Transport. Close is
// a no-op: the Transport closes the body it sent, and the guest conn still
// needs the remainder drained, boundedly, before its next request.
//
// A read through it comes off the guest conn, so it refreshes the guest-sending
// clock — not the embedded countingBody, which the response body shares: a
// response read comes off the upstream conn and says nothing about whether the
// guest is still sending.
type keptBody struct {
	countingBody
	k *idleClock
}

func (b keptBody) Read(p []byte) (int, error) {
	b.k.touch()
	return b.countingBody.Read(p)
}

func (keptBody) Close() error { return nil }

// forward sends one absolute-form http:// request over up, the connection
// already dialled to the checked address, and relays the response. It
// reports whether the guest conn may carry another request.
//
// The round trip uses a Transport made for this one request: its DialContext
// ignores the address and returns up, keep-alives are off and compression is
// off. So no upstream conn is ever pooled, let alone shared between callers,
// and the Transport adds no Accept-Encoding of its own.
func (pc *proxyConn) forward(r *http.Request, up net.Conn, ev Event) bool {
	idle := pc.p.cfg.IdleTimeout
	// Three kinds of activity, because the forward path -- unlike an opaque
	// tunnel -- knows which way each byte is going, and they do not vouch for
	// each other. Each clock lists only the deadlines its own activity proves
	// are still live.
	//
	// guestSending is refreshed by a request-body read, which comes off the
	// guest conn. It carries the upstream conn too, because http.Transport
	// starts its readLoop at dial time, blocked in Peek on the upstream conn
	// while the request is still being written: for the whole of a slow upload
	// the only activity anywhere is on the guest side, so leaving the upstream
	// deadline out would make it the one deadline a moving upload cannot
	// refresh. (net/http as it stands swallows that Peek error while a request
	// is in flight, so the omission does not surface as a 502 today -- but it
	// would still have the upstream deadline expiring on a connection whose
	// bytes are moving, which is precisely what IdleTimeout promises does not
	// happen, and it would surface if the Transport stopped swallowing it.)
	//
	// guestReading is refreshed by a response write, and touches the guest's
	// write deadline alone. It must not reach the guest's *read* deadline: a
	// guest may promise a request body, send none, and sit there while the
	// upstream trickles a response back through it, and relaying that response
	// says nothing about the body still owed.
	// TestForwardStalledGuestBodyExpiresWhileUpstreamTalks pins exactly that.
	//
	// upstreamTalking is refreshed by the Transport's own I/O and covers the
	// upstream conn only, for the mirror of the same reason.
	guestSending := &idleClock{read: []net.Conn{pc.c, up}, write: []net.Conn{up}, idle: idle}
	guestReading := &idleClock{write: []net.Conn{pc.c}, idle: idle}
	upstreamTalking := &idleClock{read: []net.Conn{up}, write: []net.Conn{up}, idle: idle}
	var handed atomic.Bool
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if handed.Swap(true) {
				return nil, errors.New("egress: checked upstream already used")
			}
			// Wrapped, not raw: the Transport writes the request, reads the
			// headers and streams the body on its own schedule, with the proxy
			// out of the loop for all three. Bounding the response body alone
			// would leave the request write unbounded, and
			// ResponseHeaderTimeout covers only the gap before the headers --
			// an upstream that sends them and then stalls mid-body is bounded
			// here and nowhere else.
			return idleConn{Conn: up, k: upstreamTalking}, nil
		},
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: maxHeaderBytes,
		ResponseHeaderTimeout:  pc.p.cfg.ResponseHeaderTimeout,
	}
	defer tr.CloseIdleConnections()

	out := r.Clone(pc.ctx)
	out.RequestURI = ""
	out.Host = r.URL.Host // the checked target, whatever the Host header said
	out.URL.User = nil
	out.Close = false
	// Declared trailer names would be announced upstream in a Trailer header
	// and their values sent unscrubbed: send no request trailers at all.
	out.Trailer = nil
	scrubHeaders(out.Header)
	if _, ok := out.Header["User-Agent"]; !ok {
		out.Header["User-Agent"] = []string{""} // suppress Go's default User-Agent
	}
	var bytesUp atomic.Int64
	if r.Body != nil && r.Body != http.NoBody {
		out.Body = keptBody{countingBody: countingBody{ReadCloser: r.Body, n: &bytesUp}, k: guestSending}
	}

	resp, err := tr.RoundTrip(out)
	if err != nil {
		ev.Status, ev.Decision = http.StatusBadGateway, DecisionUpstreamUnreachable
		ev.BytesUp = bytesUp.Load()
		pc.refuse(ev, ev.Host)
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 100 && resp.StatusCode < 200 {
		// Upgrade was stripped, so a 101 (or any other 1xx the Transport
		// returns) is an upstream switching protocols unasked: never relay
		// the raw stream behind it.
		ev.Status, ev.Decision = http.StatusBadGateway, DecisionUpstreamUnreachable
		ev.BytesUp = bytesUp.Load()
		pc.refuse(ev, ev.Host)
		return false
	}
	scrubHeaders(resp.Header)
	// Response trailers are scrubbed like headers, twice: the declared names
	// now, which Response.Write announces in its Trailer header, and the
	// values at body EOF, when the Transport merges them into the same map
	// that Response.Write then sends.
	scrubTrailer(resp.Trailer)
	// The guest conn stays open only for a length-delimited response, and
	// Response.Write closes after anything else. resp.Close describes the
	// upstream conn, which is never reused, so it does not bear on this.
	keep := !r.Close && (resp.ContentLength >= 0 || chunked(resp.TransferEncoding))
	resp.Close = !keep
	var bytesDown atomic.Int64
	resp.Body = trailerScrubBody{countingBody{ReadCloser: resp.Body, n: &bytesDown}, resp}
	// Written through the wrapper so a guest that stops reading a large
	// response cannot park its slot either: a peer that has stopped reading
	// holds a connection just as effectively as one that has stopped sending.
	werr := resp.Write(idleWriter{c: pc.c, k: guestReading})

	ev.Status, ev.Decision = resp.StatusCode, DecisionForward
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, false)
	if werr != nil || !keep {
		return false
	}
	// Any request body the upstream left unread would be parsed as the next
	// request: drain a bounded amount, else end the conn. It reads pc.c, so it
	// sits inside the idle bound rather than after it.
	if r.Body != nil {
		if n, err := io.Copy(io.Discard, io.LimitReader(keptBody{
			countingBody: countingBody{ReadCloser: r.Body, n: new(atomic.Int64)}, k: guestSending,
		}, drainLimit+1)); err != nil || n > drainLimit {
			return false
		}
	}
	// The next request's own read deadline is armed at the top of serve's
	// loop, but a write deadline left over from this response would misfire on
	// it. Clear both and let serve set what it needs.
	_ = pc.c.SetDeadline(time.Time{})
	return true
}

func chunked(te []string) bool { return len(te) > 0 && te[0] == "chunked" }
