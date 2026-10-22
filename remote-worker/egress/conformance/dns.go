//go:build unix

package conformance

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeDNS is a UDP DNS server on 127.0.0.1. A queries are answered from a
// per-name sequence of answer sets: the n-th A query for a name gets the n-th
// set, and the last set repeats. AAAA queries for a known name get an empty
// NOERROR, so only the A answers decide where a name points. Unknown names
// get NXDOMAIN. A queries are counted per name.
type fakeDNS struct {
	pc net.PacketConn

	mu      sync.Mutex
	answers map[string][][]netip.Addr
	aCount  map[string]int
	done    chan struct{}
}

func startDNS() (*fakeDNS, error) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	d := &fakeDNS{pc: pc, answers: map[string][][]netip.Addr{}, aCount: map[string]int{}, done: make(chan struct{})}
	go d.serve()
	return d, nil
}

func (d *fakeDNS) addr() string { return d.pc.LocalAddr().String() }

func dnsKey(name string) string { return strings.ToLower(strings.TrimSuffix(name, ".")) }

// answer appends one answer set to name's sequence. Each address must be
// IPv4: the server answers A records only.
func (d *fakeDNS) answer(name string, addrs ...string) error {
	set := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		ip, err := netip.ParseAddr(a)
		if err != nil {
			return err
		}
		if !ip.Is4() {
			return errors.New("fake DNS answers A records only: " + a)
		}
		set = append(set, ip)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	k := dnsKey(name)
	d.answers[k] = append(d.answers[k], set)
	return nil
}

// queries reports how many A queries name has received.
func (d *fakeDNS) queries(name string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.aCount[dnsKey(name)]
}

func (d *fakeDNS) close() {
	_ = d.pc.Close()
	<-d.done
}

func (d *fakeDNS) serve() {
	defer close(d.done)
	buf := make([]byte, 1500)
	for {
		n, from, err := d.pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if out, ok := d.reply(buf[:n]); ok {
			_, _ = d.pc.WriteTo(out, from)
		}
	}
}

func (d *fakeDNS) reply(req []byte) ([]byte, bool) {
	var p dnsmessage.Parser
	h, err := p.Start(req)
	if err != nil {
		return nil, false
	}
	q, err := p.Question()
	if err != nil {
		return nil, false
	}
	// Authoritative and RecursionAvailable: Go's resolver treats an empty
	// NOERROR without either as a lame referral.
	rh := dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true,
		RecursionDesired: h.RecursionDesired, RecursionAvailable: true}

	k := dnsKey(q.Name.String())
	var set []netip.Addr
	d.mu.Lock()
	seq, known := d.answers[k]
	if q.Type == dnsmessage.TypeA && q.Class == dnsmessage.ClassINET {
		if known {
			i := d.aCount[k]
			if i >= len(seq) {
				i = len(seq) - 1
			}
			set = seq[i]
		}
		d.aCount[k]++
	}
	d.mu.Unlock()
	if !known {
		rh.RCode = dnsmessage.RCodeNameError
	}

	b := dnsmessage.NewBuilder(make([]byte, 0, 512), rh)
	b.EnableCompression()
	if b.StartQuestions() != nil || b.Question(q) != nil || b.StartAnswers() != nil {
		return nil, false
	}
	for _, a := range set {
		rr := dnsmessage.AResource{A: a.As4()}
		if b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 0}, rr) != nil {
			return nil, false
		}
	}
	out, err := b.Finish()
	return out, err == nil
}
