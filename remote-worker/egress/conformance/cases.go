//go:build unix

package conformance

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// Each case is pinned: it was run against moca-egress with the named rule
// broken and observed to FAIL. The "pinned against" comment names the
// mutation.

// identityFromConnection: the caller is decided by the listener a connection
// arrives on. Two VMs of two sessions each open a tunnel; each audit event
// names the VM and session its socket was registered with, and no other.
//
// pinned against: binding every accepted conn to one fixed caller in
// Proxy.serve instead of the VM binding's caller.
func identityFromConnection(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		for _, v := range []vm{a, b} {
			g, err := h.dial(v)
			if err != nil {
				return err
			}
			r, err := g.connect(hp)
			if err == nil && r.status != 200 {
				err = fmt.Errorf("CONNECT on %s: status %d %q", v.id, r.status, r.body)
			}
			if err == nil {
				err = g.echoThrough([]byte("hello from " + v.id))
			}
			g.close()
			if err != nil {
				return err
			}
			if _, err := h.wait(event{"decision": "tunnel", "vm_id": v.id, "sid": v.sid}); err != nil {
				return err
			}
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			vmID, sid := m["vm_id"], m["sid"]
			if (vmID == "vm-a" && sid != "sid-a") || (vmID == "vm-b" && sid != "sid-b") ||
				(vmID != "vm-a" && vmID != "vm-b") {
				return fmt.Errorf("event with vm_id %v sid %v: identity not from the connection: %v", vmID, sid, m)
			}
		}
		return nil
	})
}

// forgedSessionHeaderIgnored: a request on vm-b's socket that names vm-a's
// session, VM and subject in X-Moca-* headers and carries a
// Proxy-Authorization is still vm-b's, and none of those headers reaches the
// upstream. vm-a's session is capped at one request and has used it, so a
// forged header that moved the request to vm-a's session would also be
// refused with 429.
//
// pinned against: letting an X-Moca-Session request header override the
// caller's session in proxyConn.handle.
func forgedSessionHeaderIgnored(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		h.env[EnvMaxRequests] = "1"
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		ga, err := h.dial(a)
		if err != nil {
			return err
		}
		defer ga.close()
		if r, err := ga.get(upURL(up.port(), "/a")); err != nil || r.status != 200 {
			return fmt.Errorf("vm-a's own request: %v %v", r.status, err)
		}
		gb, err := h.dial(b)
		if err != nil {
			return err
		}
		defer gb.close()
		r, err := gb.get(upURL(up.port(), "/b"),
			"X-Moca-Session: sid-a", "X-Moca-Sid: sid-a", "X-Moca-Vm-Id: vm-a", "X-Moca-Sub: alice",
			"Proxy-Authorization: Basic YWxpY2U6c2VjcmV0")
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("vm-b's request with forged headers: status %d %q, want 200", r.status, r.body)
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/b", "vm_id": "vm-b", "sid": "sid-b"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			if m["path"] == "/b" && (m["vm_id"] != "vm-b" || m["sid"] != "sid-b" || !noSubject(m)) {
				return fmt.Errorf("forged headers changed the caller: %v", m)
			}
		}
		for _, rq := range up.requests() {
			if rq.path != "/b" {
				continue
			}
			for k := range rq.header {
				lk := strings.ToLower(k)
				if strings.HasPrefix(lk, "x-moca-") || lk == "proxy-authorization" {
					return fmt.Errorf("upstream received %s", k)
				}
			}
		}
		return nil
	})
}

// offAllowlistNamed403: a destination off the allowlist is refused by name,
// for CONNECT and for plain HTTP, before it is resolved and before any dial.
// The name resolves to the permitted fake upstream, so only the allowlist
// stands in the way.
//
// pinned against: Allowed returning true for every host.
func offAllowlistNamed403(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const off = "off.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(off, "127.0.0.1"); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(off, strconv.Itoa(echo.port()))
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.connect(hp)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", off); err != nil {
			return fmt.Errorf("CONNECT %s: %w", hp, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://" + hp + "/x")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", off); err != nil {
			return fmt.Errorf("GET http://%s/x: %w", hp, err)
		}
		if _, err := h.wait(event{"decision": "destination_denied", "host": off, "method": "CONNECT", "status": 403, "vm_id": "vm-a"}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "destination_denied", "host": off, "method": "GET", "status": 403}); err != nil {
			return err
		}
		if n := echo.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		if n := h.dns.queries(off); n != 0 {
			return fmt.Errorf("%s was resolved %d times before its allowlist refusal, want 0", off, n)
		}
		return nil
	})
}

// privateAddress403: an allowlisted name that resolves to a loopback
// address is refused as destination_private when no permit prefix covers it,
// and nothing is dialled. So is an allowlisted private IP literal.
//
// pinned against: skipping the CheckAddr loop in resolveAndCheck.
func privateAddress403(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const priv = "priv.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(priv, "127.0.0.1"); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:%d,127.0.0.1:%d", priv, echo.port(), echo.port())
		return nil // no MOCA_EGRESS_PERMIT_CIDRS
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		for _, host := range []string{priv, "127.0.0.1"} {
			hp := net.JoinHostPort(host, strconv.Itoa(echo.port()))
			g, err := h.dial(v)
			if err != nil {
				return err
			}
			r, err := g.connect(hp)
			g.close()
			if err != nil {
				return err
			}
			if err := wantRefusal(r, 403, "destination_private", host); err != nil {
				return fmt.Errorf("CONNECT %s: %w", hp, err)
			}
			if _, err := h.wait(event{"decision": "destination_private", "host": host, "status": 403}); err != nil {
				return err
			}
		}
		if n := echo.acceptCount(); n != 0 {
			return fmt.Errorf("upstream accepted %d conns, want 0", n)
		}
		return nil
	})
}

// metadataAddress403EvenIfPermitted: the link-local metadata address is
// refused even when a permit prefix covers it, as an IP literal and behind an
// allowlisted name.
//
// pinned against: treating link-local unicast as permit-able (restricted)
// rather than always refused in CheckAddr.
func metadataAddress403EvenIfPermitted(ctx context.Context, t Target) error {
	const meta, metaIP = "meta.test", "169.254.169.254"
	return run(ctx, t, func(h *harness) error {
		if err := h.dns.answer(meta, metaIP); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:80,%s:443,%s:80", metaIP, metaIP, meta)
		h.env[EnvPermit] = "169.254.0.0/16,0.0.0.0/0"
		return nil
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		r, err := g.get("http://" + metaIP + "/latest/meta-data/")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", metaIP); err != nil {
			return fmt.Errorf("GET http://%s/: %w", metaIP, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.connect(metaIP + ":443")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", metaIP); err != nil {
			return fmt.Errorf("CONNECT %s:443: %w", metaIP, err)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://" + meta + "/latest/meta-data/")
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_private", meta); err != nil {
			return fmt.Errorf("GET http://%s/: %w", meta, err)
		}
		for _, host := range []string{metaIP, meta} {
			if _, err := h.wait(event{"decision": "destination_private", "host": host, "status": 403}); err != nil {
				return err
			}
		}
		return nil
	})
}

// dnsRebindingResolvedOnce: the name answers 127.0.0.1 (the permitted fake
// upstream) first and 10.0.0.9 (private, not permitted) for every later A
// query. The proxy must resolve once, check that answer and dial exactly it:
// the A-query count is 1, the tunnel reaches the fake upstream, and the
// audit's dial_addr is the checked address.
//
// The count is exact because the fake DNS answers at once: Go's resolver
// issues the A and AAAA queries in parallel for network "ip" but retries only
// after a timeout (5 s by default), so it sends one A query per lookup.
//
// pinned against: resolving the name a second time in proxyConn.handle and
// dialling the second answer.
func dnsRebindingResolvedOnce(ctx context.Context, t Target) error {
	var echo *echoUpstream
	const rebind = "rebind.test"
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if err := h.dns.answer(rebind, "127.0.0.1"); err != nil {
			return err
		}
		if err := h.dns.answer(rebind, "10.0.0.9"); err != nil {
			return err
		}
		h.env[EnvAllow] = fmt.Sprintf("%s:%d", rebind, echo.port())
		h.env[EnvPermit] = "127.0.0.1/32"
		return nil
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		hp := net.JoinHostPort(rebind, strconv.Itoa(echo.port()))
		r, err := g.connect(hp)
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("CONNECT %s: status %d %q, want 200 to the first, checked answer", hp, r.status, r.body)
		}
		if err := g.echoThrough([]byte("rebind")); err != nil {
			return err
		}
		g.close()
		want := net.JoinHostPort("127.0.0.1", strconv.Itoa(echo.port()))
		if _, err := h.wait(event{"decision": "tunnel", "host": rebind, "dial_addr": want}); err != nil {
			return err
		}
		if n := h.dns.queries(rebind); n != 1 {
			return fmt.Errorf("%s got %d A queries, want exactly 1", rebind, n)
		}
		return nil
	})
}

// perVMConnCap429: with MOCA_EGRESS_MAX_CONNS_PER_VM=2 and two live tunnels
// on vm-a, a third conn on vm-a is refused 429 conn_cap, naming the VM,
// while vm-b of the same session is unaffected.
//
// pinned against: comparing the live-conn count with > instead of >= in
// Proxy.admit.
func perVMConnCap429(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		h.env[EnvMaxConns] = "2"
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-a")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		open := func(v vm) (*guest, error) {
			g, err := h.dial(v)
			if err != nil {
				return nil, err
			}
			r, err := g.connect(hp)
			if err == nil && r.status != 200 {
				err = fmt.Errorf("CONNECT on %s: status %d %q, want 200", v.id, r.status, r.body)
			}
			if err != nil {
				g.close()
				return nil, err
			}
			return g, nil
		}
		for i := 0; i < 2; i++ {
			g, err := open(a)
			if err != nil {
				return fmt.Errorf("tunnel %d: %w", i+1, err)
			}
			defer g.close()
		}
		g, err := h.dial(a)
		if err != nil {
			return err
		}
		r, err := g.connect(hp)
		g.close()
		if err != nil {
			return fmt.Errorf("third conn on vm-a: %w", err)
		}
		if err := wantRefusal(r, 429, "conn_cap", "vm-a"); err != nil {
			return fmt.Errorf("third conn on vm-a: %w", err)
		}
		if _, err := h.wait(event{"decision": "conn_cap", "vm_id": "vm-a", "sid": "sid-a", "status": 429}); err != nil {
			return err
		}
		gb, err := open(b)
		if err != nil {
			return fmt.Errorf("vm-b, under its own cap: %w", err)
		}
		gb.close()
		return nil
	})
}

// perSessionRequestCap429: with MOCA_EGRESS_MAX_REQUESTS_PER_SESSION=3, the
// fourth request of a session is refused 429 request_cap even though it
// spans two VMs and two conns; another session still gets through. The
// refused request never reaches the upstream.
//
// pinned against: charging requests per VM id instead of per session in
// proxyConn.handle.
func perSessionRequestCap429(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		h.env[EnvMaxRequests] = "3"
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-s")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-s")
		if err != nil {
			return err
		}
		c, err := h.register("vm-c", "sid-t")
		if err != nil {
			return err
		}
		ga, err := h.dial(a)
		if err != nil {
			return err
		}
		defer ga.close()
		gb, err := h.dial(b)
		if err != nil {
			return err
		}
		defer gb.close()
		steps := []struct {
			g    *guest
			path string
		}{{ga, "/1"}, {ga, "/2"}, {gb, "/3"}}
		for _, s := range steps {
			r, err := s.g.get(upURL(up.port(), s.path))
			if err != nil {
				return fmt.Errorf("request %s: %w", s.path, err)
			}
			if r.status != 200 {
				return fmt.Errorf("request %s: status %d %q, want 200", s.path, r.status, r.body)
			}
		}
		r, err := gb.get(upURL(up.port(), "/4"))
		if err != nil {
			return fmt.Errorf("request /4: %w", err)
		}
		if err := wantRefusal(r, 429, "request_cap", upName); err != nil {
			return fmt.Errorf("request /4: %w", err)
		}
		if _, err := h.wait(event{"decision": "request_cap", "sid": "sid-s", "vm_id": "vm-b", "status": 429}); err != nil {
			return err
		}
		gc, err := h.dial(c)
		if err != nil {
			return err
		}
		defer gc.close()
		if r, err := gc.get(upURL(up.port(), "/other")); err != nil || r.status != 200 {
			return fmt.Errorf("another session's request: status %d, %v; want 200", r.status, err)
		}
		for _, rq := range up.requests() {
			if rq.path == "/4" {
				return errors.New("the capped request reached the upstream")
			}
		}
		return nil
	})
}

// unregisterAbortsInflight: Unregister closes vm-a's listener and every live
// conn of vm-a (a tunnel and a plain-HTTP request the upstream is still
// holding) before it returns. Each conn yields exactly one aborted event and
// no other terminal event; vm-b is untouched.
//
// pinned against: Proxy.Unregister closing the listener but not aborting the
// VM's live conns.
func unregisterAbortsInflight(ctx context.Context, t Target) error {
	var echo *echoUpstream
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port(), up.port())
	}, func(h *harness) error {
		a, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		b, err := h.register("vm-b", "sid-b")
		if err != nil {
			return err
		}
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		tun, err := h.dial(a)
		if err != nil {
			return err
		}
		defer tun.close()
		if r, err := tun.connect(hp); err != nil || r.status != 200 {
			return fmt.Errorf("tunnel on vm-a: status %d, %v", r.status, err)
		}
		if err := tun.echoThrough([]byte("live")); err != nil {
			return err
		}
		slow, err := h.dial(a)
		if err != nil {
			return err
		}
		defer slow.close()
		raw := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s:%d\r\n\r\n", upURL(up.port(), "/slow"), upName, up.port())
		if _, err := slow.c.Write([]byte(raw)); err != nil {
			return err
		}
		select {
		case <-up.slowArrived:
		case <-time.After(eventWait):
			return errors.New("the in-flight request never reached the upstream")
		}
		other, err := h.dial(b)
		if err != nil {
			return err
		}
		defer other.close()
		if r, err := other.connect(hp); err != nil || r.status != 200 {
			return fmt.Errorf("tunnel on vm-b: status %d, %v", r.status, err)
		}

		if err := h.client.Unregister(h.ctx, "vm-a"); err != nil {
			return fmt.Errorf("unregister vm-a: %w", err)
		}
		if c, err := net.DialTimeout("unix", a.path, time.Second); err == nil {
			_ = c.Close()
			return errors.New("vm-a's socket still accepts after Unregister returned")
		}
		if err := tun.closedWithin(eventWait); err != nil {
			return fmt.Errorf("vm-a's tunnel after Unregister: %w", err)
		}
		if err := slow.closedWithin(eventWait); err != nil {
			return fmt.Errorf("vm-a's in-flight request after Unregister: %w", err)
		}
		if _, err := h.wait(event{"decision": "aborted", "vm_id": "vm-a", "method": "CONNECT"}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "aborted", "vm_id": "vm-a", "method": "GET"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		if n := h.count(event{"decision": "aborted", "vm_id": "vm-a"}); n != 2 {
			return fmt.Errorf("%d aborted events for vm-a, want 2: %s", n, h.seenText())
		}
		for _, d := range []string{"tunnel", "forward"} {
			if n := h.count(event{"decision": d, "vm_id": "vm-a"}); n != 0 {
				return fmt.Errorf("%d %s events for vm-a besides aborted, want 0: %s", n, d, h.seenText())
			}
		}
		if n := h.count(event{"vm_id": "vm-b"}); n != 0 {
			return fmt.Errorf("vm-b's live tunnel was ended by vm-a's Unregister: %s", h.seenText())
		}
		if err := other.echoThrough([]byte("still here")); err != nil {
			return fmt.Errorf("vm-b after vm-a's Unregister: %w", err)
		}
		return nil
	})
}

// connectTunnelOpaque: after a checked CONNECT the proxy is a byte pipe. Bytes
// pipelined behind the CONNECT request, bytes that look like HTTP, and binary
// data all arrive unchanged; a half-close travels upstream while the echo still
// flows back, ending in a clean EOF; the tunnel event
// counts the bytes each way and names the dialled address.
//
// pinned against: splicing from the raw guest conn instead of the buffered
// reader in tunnel, which drops the bytes pipelined behind the CONNECT; and
// splice closing both conns on the first EOF instead of half-closing, which
// loses the trailing echo.
func connectTunnelOpaque(ctx context.Context, t Target) error {
	var echo *echoUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		hp := net.JoinHostPort(upName, strconv.Itoa(echo.port()))
		early := []byte("GET /not-parsed HTTP/1.1\r\nHost: evil.test\r\nX-Moca-Session: forged\r\n\r\n")
		raw := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", hp, hp)
		if _, err := g.c.Write(append([]byte(raw), early...)); err != nil {
			return err
		}
		r, err := g.readConnectReply()
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("CONNECT %s: status %d %q, want 200", hp, r.status, r.body)
		}
		got := make([]byte, len(early))
		if _, err := io.ReadFull(g.br, got); err != nil {
			return fmt.Errorf("pipelined bytes: %w", err)
		}
		if string(got) != string(early) {
			return fmt.Errorf("pipelined bytes came back as %q, want %q", got, early)
		}
		bin := make([]byte, 256<<10)
		if _, err := rand.Read(bin); err != nil {
			return err
		}
		if err := g.echoThrough(bin); err != nil {
			return err
		}
		// Half-close: a trailing chunk, then CloseWrite at once, without
		// waiting for its echo. The proxy must carry the EOF upstream and keep
		// the downstream direction open, so the echo of the chunk still
		// arrives, followed by a clean EOF (not a reset).
		trail := make([]byte, 64<<10)
		if _, err := rand.Read(trail); err != nil {
			return err
		}
		if _, err := g.c.Write(trail); err != nil {
			return fmt.Errorf("trailing write: %w", err)
		}
		if err := g.c.(*net.UnixConn).CloseWrite(); err != nil {
			return err
		}
		_ = g.c.SetReadDeadline(time.Now().Add(eventWait))
		rest, err := io.ReadAll(g.br)
		if err != nil {
			return fmt.Errorf("half-close through the tunnel: read after CloseWrite ended with %v after %d bytes, want a clean EOF", err, len(rest))
		}
		if !bytes.Equal(rest, trail) {
			return fmt.Errorf("half-close through the tunnel: got %d bytes after CloseWrite, want the %d-byte trailing echo", len(rest), len(trail))
		}
		total := len(early) + len(bin) + len(trail)
		dial := net.JoinHostPort("127.0.0.1", strconv.Itoa(echo.port()))
		if _, err := h.wait(event{"decision": "tunnel", "status": 200, "host": upName, "method": "CONNECT",
			"dial_addr": dial, "bytes_up": total, "bytes_down": total}); err != nil {
			return err
		}
		return nil
	})
}

// plainHTTPStripsProxyAndMocaHeaders: an absolute-form http:// request is
// forwarded with every Proxy-* header (not only the hop-by-hop Proxy-Authorization
// and Proxy-Connection), the hop-by-hop headers, the headers Connection names and
// every X-Moca-* header removed, and the upstream's X-Moca-* and Proxy-* response
// headers never reach the guest, so an upstream cannot forge a named refusal.
// Other headers pass both ways.
//
// pinned against: dropping the X-Moca-* loop from scrubHeaders, and dropping its
// Proxy-* prefix loop (Proxy-Tenant then reaches upstream).
func plainHTTPStripsProxyAndMocaHeaders(ctx context.Context, t Target) error {
	var up *httpUpstream
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		defer g.close()
		r, err := g.get(upURL(up.port(), "/hdr"),
			"Proxy-Authorization: Basic YWxpY2U6c2VjcmV0",
			"Proxy-Connection: keep-alive",
			"Connection: keep-alive, X-Named-Hop",
			"X-Named-Hop: 1",
			"Keep-Alive: timeout=5",
			"X-Moca-Session: forged",
			"x-moca-egress-error: forged",
			"Proxy-Tenant: other",
			"proxy-remote-user: root",
			"X-Kept-Request: 1")
		if err != nil {
			return err
		}
		if r.status != 200 || r.body != "ok" {
			return fmt.Errorf("status %d body %q, want 200 \"ok\"", r.status, r.body)
		}
		for k := range r.header {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "x-moca-") || strings.HasPrefix(lk, "proxy-") {
				return fmt.Errorf("guest received upstream response header %s: %v", k, r.header[k])
			}
		}
		if r.header.Get("X-Kept") != "1" {
			return fmt.Errorf("response header X-Kept was dropped: %v", r.header)
		}
		reqs := up.requests()
		if len(reqs) != 1 {
			return fmt.Errorf("upstream saw %d requests, want 1", len(reqs))
		}
		rq := reqs[0]
		for k := range rq.header {
			lk := strings.ToLower(k)
			switch {
			case strings.HasPrefix(lk, "x-moca-"), strings.HasPrefix(lk, "proxy-"),
				lk == "keep-alive", lk == "x-named-hop":
				return fmt.Errorf("upstream received request header %s: %v", k, rq.header[k])
			}
		}
		if rq.header.Get("X-Kept-Request") != "1" {
			return fmt.Errorf("request header X-Kept-Request was dropped: %v", rq.header)
		}
		if want := fmt.Sprintf("%s:%d", upName, up.port()); rq.host != want {
			return fmt.Errorf("upstream Host %q, want %q", rq.host, want)
		}
		_, err = h.wait(event{"decision": "forward", "status": 200, "path": "/hdr"})
		return err
	})
}

// auditQueryRemoved: the audit path carries no query string and no userinfo,
// for a forwarded request and for a refused one, while the forwarded request
// itself reaches the upstream with its query intact.
//
// pinned against: RedactPath returning the request URI (path and query).
func auditQueryRemoved(ctx context.Context, t Target) error {
	var up *httpUpstream
	const secret, pass = "s3cr3t-token-value", "s3cr3t-password"
	return run(ctx, t, func(h *harness) (err error) {
		if up, err = h.httpUp(); err != nil {
			return err
		}
		return h.loopbackUpstreams(up.port())
	}, func(h *harness) error {
		v, err := h.register("vm-a", "sid-a")
		if err != nil {
			return err
		}
		g, err := h.dial(v)
		if err != nil {
			return err
		}
		u := fmt.Sprintf("http://user:%s@%s:%d/a/b%%20c?token=%s&x=1", pass, upName, up.port(), secret)
		r, err := g.get(u)
		g.close()
		if err != nil {
			return err
		}
		if r.status != 200 {
			return fmt.Errorf("forwarded request: status %d %q, want 200", r.status, r.body)
		}
		g, err = h.dial(v)
		if err != nil {
			return err
		}
		r, err = g.get("http://off.test/refused?token=" + secret)
		g.close()
		if err != nil {
			return err
		}
		if err := wantRefusal(r, 403, "destination_denied", "off.test"); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "forward", "path": "/a/b%20c", "host": upName}); err != nil {
			return err
		}
		if _, err := h.wait(event{"decision": "destination_denied", "path": "/refused", "host": "off.test"}); err != nil {
			return err
		}
		if err := h.settle(); err != nil {
			return err
		}
		for _, m := range h.seen {
			j, _ := json.Marshal(m)
			if s := string(j); strings.Contains(s, secret) || strings.Contains(s, pass) || strings.Contains(s, "token=") {
				return fmt.Errorf("audit event carries the query or userinfo: %s", s)
			}
		}
		reqs := up.requests()
		if len(reqs) != 1 || reqs[0].rawQuery != "token="+secret+"&x=1" {
			return fmt.Errorf("upstream requests %+v, want one with the query intact", reqs)
		}
		return nil
	})
}

// grantRefusedUnderSingle: under MOCA_TENANCY=single this slice has no
// grants, so a Register carrying one is refused bad_request and binds
// nothing (the same VM id then registers cleanly). MOCA_TENANCY=multi is a
// boot failure.
//
// pinned against: dropping the non-empty-grant refusal from Proxy.Register.
func grantRefusedUnderSingle(ctx context.Context, t Target) error {
	var echo *echoUpstream
	err := run(ctx, t, func(h *harness) (err error) {
		if echo, err = h.echo(); err != nil {
			return err
		}
		h.env[EnvTenancy] = "single"
		return h.loopbackUpstreams(echo.port())
	}, func(h *harness) error {
		ln, f, _, err := h.newVMListener("vm-g")
		if err != nil {
			return err
		}
		defer ln.Close()
		defer f.Close()
		err = h.client.Register(h.ctx, "vm-g", "sid-a", []byte("a-grant"), f)
		var re *control.RefusalError
		if !errors.As(err, &re) || re.Code != "bad_request" {
			return fmt.Errorf("Register with a grant: %v, want a bad_request refusal", err)
		}
		if _, err := h.register("vm-g", "sid-a"); err != nil {
			return fmt.Errorf("the refused registration left a binding: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	h, err := newHarness(ctx)
	if err != nil {
		return err
	}
	defer h.close()
	h.env[EnvTenancy] = "multi"
	h.env[EnvAllow] = "up.test"
	inst, err := t.Start(ctx, h.env)
	if err == nil {
		_ = inst.Stop()
		return errors.New("MOCA_TENANCY=multi: the instance started, want a boot failure")
	}
	if !strings.Contains(err.Error(), EnvTenancy) {
		return fmt.Errorf("MOCA_TENANCY=multi: boot failure %q does not name %s", err, EnvTenancy)
	}
	return nil
}

// noSubject reports whether an event carries no subject: sub absent or "".
func noSubject(m map[string]any) bool {
	v, ok := m["sub"]
	return !ok || v == ""
}
