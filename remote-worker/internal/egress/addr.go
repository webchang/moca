package egress

import (
	"errors"
	"fmt"
	"net/netip"
)

// ErrPrivate is returned for a destination address the proxy must not dial.
var ErrPrivate = errors.New("destination_private")

var (
	cgnat   = netip.MustParsePrefix("100.64.0.0/10")
	thisNet = netip.MustParsePrefix("0.0.0.0/8")
	v4Bcast = netip.MustParseAddr("255.255.255.255")
)

// cloudMetadata are instance-metadata endpoints OUTSIDE 169.254/16 (which is link-local and
// refused anyway). They are refused before the permit list is consulted: an operator permitting
// fd00::/8 or 100.64/10 for an internal service must not thereby open the instance's
// credentials, and Azure's WireServer is a public address that needs no permit at all.
var cloudMetadata = []netip.Prefix{
	netip.MustParsePrefix("fd00:ec2::254/128"),  // AWS IMDS over IPv6
	netip.MustParsePrefix("168.63.129.16/32"),   // Azure WireServer
	netip.MustParsePrefix("100.100.100.200/32"), // Alibaba Cloud metadata
}

// specialPurpose are IANA special-purpose blocks that are not globally reachable (RFC 6890 and
// its registries) and that netip's predicates do not already classify. They are treated like
// private space: refused unless inside a permit prefix.
var specialPurpose = []netip.Prefix{
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // TEST-NET-1
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),  // TEST-NET-3
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved
	netip.MustParsePrefix("100::/64"),        // discard-only
	netip.MustParsePrefix("2001:db8::/32"),   // documentation
}

// CheckAddr refuses addresses the proxy must not dial. Link-local unicast, unspecified,
// multicast, broadcast and the cloud metadata endpoints are always refused, whatever the permit
// list. Loopback, private, CGNAT, 0.0.0.0/8, the special-purpose blocks and any address in local
// are refused unless inside a permit prefix. v4-mapped IPv6 forms are classified as IPv4, and
// IPv6 forms that embed an IPv4 address (NAT64, 6to4, SIIT, Teredo) are judged by it as well.
func CheckAddr(a netip.Addr, permit []netip.Prefix, local []netip.Addr) error {
	a = a.Unmap().WithZone("")
	if !a.IsValid() || a.IsUnspecified() || a.IsLinkLocalUnicast() || a.IsMulticast() ||
		a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a == v4Bcast {
		return fmt.Errorf("%w: %s", ErrPrivate, a)
	}
	for _, m := range cloudMetadata {
		if m.Contains(a) {
			return fmt.Errorf("%w: %s (cloud metadata)", ErrPrivate, a)
		}
	}
	if a.Is6() {
		// Deprecated forms, never dialled: IPv4-compatible (::/96, except ::1,
		// which is plain loopback) and site-local.
		if (v4Compat.Contains(a) && a != v6Loopback) || siteLocal.Contains(a) {
			return fmt.Errorf("%w: %s", ErrPrivate, a)
		}
		// Embedded IPv4 is judged as if it were dialled directly.
		b := a.As16()
		var embedded []netip.Addr
		switch {
		case nat64.Contains(a):
			embedded = append(embedded, netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case nat64Local.Contains(a):
			// Last 32 bits, and the RFC 6052 /48 layout (bytes 6,7 and 9,10).
			embedded = append(embedded,
				netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}),
				netip.AddrFrom4([4]byte{b[6], b[7], b[9], b[10]}))
		case sixToFour.Contains(a):
			embedded = append(embedded, netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
		case siit.Contains(a):
			// ::ffff:0:a.b.c.d (RFC 6145); Unmap only handles ::ffff:a.b.c.d.
			embedded = append(embedded, netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case teredo.Contains(a):
			// RFC 4380: the server IPv4 in bytes 4-7, the client IPv4 inverted in bytes 12-15.
			embedded = append(embedded,
				netip.AddrFrom4([4]byte{b[4], b[5], b[6], b[7]}),
				netip.AddrFrom4([4]byte{^b[12], ^b[13], ^b[14], ^b[15]}))
		}
		for _, e := range embedded {
			if err := CheckAddr(e, permit, local); err != nil {
				return fmt.Errorf("%w: %s embeds %s", ErrPrivate, a, e)
			}
		}
	}
	restricted := a.IsLoopback() || a.IsPrivate() || cgnat.Contains(a) || thisNet.Contains(a)
	for _, sp := range specialPurpose {
		if !restricted && sp.Contains(a) {
			restricted = true
		}
	}
	if !restricted {
		for _, l := range local {
			if l.Unmap().WithZone("") == a {
				restricted = true
				break
			}
		}
	}
	if !restricted {
		return nil
	}
	for _, p := range permit {
		if p.Contains(a) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrPrivate, a)
}

var (
	v4Compat   = netip.MustParsePrefix("::/96")
	siteLocal  = netip.MustParsePrefix("fec0::/10")
	nat64      = netip.MustParsePrefix("64:ff9b::/96")
	nat64Local = netip.MustParsePrefix("64:ff9b:1::/48")
	sixToFour  = netip.MustParsePrefix("2002::/16")
	siit       = netip.MustParsePrefix("::ffff:0:0:0/96")
	teredo     = netip.MustParsePrefix("2001::/32")
	v6Loopback = netip.MustParseAddr("::1")
)
