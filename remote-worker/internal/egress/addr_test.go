package egress

import (
	"errors"
	"net/netip"
	"testing"
)

func pfx(s string) []netip.Prefix { return []netip.Prefix{netip.MustParsePrefix(s)} }

func TestCheckAddrRefusesMetadataEvenWhenPermitted(t *testing.T) {
	for _, s := range []string{
		"169.254.169.254", "::ffff:169.254.169.254", "fe80::1", "0.0.0.0", "::",
		"224.0.0.1", "ff02::1", "255.255.255.255", "::ffff:0.0.0.0",
	} {
		permit := []netip.Prefix{
			netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fe80::/10"),
			netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0"),
		}
		err := CheckAddr(netip.MustParseAddr(s), permit, nil)
		if !errors.Is(err, ErrPrivate) {
			t.Errorf("CheckAddr(%s) = %v, want ErrPrivate", s, err)
		}
	}
}

func TestCheckAddrPermitsOnlyListedPrivate(t *testing.T) {
	a := netip.MustParseAddr("10.1.2.3")
	if err := CheckAddr(a, nil, nil); !errors.Is(err, ErrPrivate) {
		t.Fatalf("unpermitted 10.1.2.3: %v", err)
	}
	if err := CheckAddr(a, pfx("10.1.0.0/16"), nil); err != nil {
		t.Fatalf("permitted 10.1.2.3: %v", err)
	}
	if err := CheckAddr(a, pfx("10.2.0.0/16"), nil); !errors.Is(err, ErrPrivate) {
		t.Fatalf("other prefix: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("::ffff:10.1.2.3"), pfx("10.1.0.0/16"), nil); err != nil {
		t.Fatalf("mapped permitted: %v", err)
	}
	for _, s := range []string{"127.0.0.1", "::1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fd00::1", "0.1.2.3"} {
		if err := CheckAddr(netip.MustParseAddr(s), nil, nil); !errors.Is(err, ErrPrivate) {
			t.Errorf("%s: %v", s, err)
		}
	}
	local := netip.MustParseAddr("203.0.113.9")
	if err := CheckAddr(local, nil, []netip.Addr{local}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("local: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("::ffff:203.0.113.9"), nil, []netip.Addr{local}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("mapped local: %v", err)
	}
	if err := CheckAddr(local, pfx("203.0.113.0/24"), []netip.Addr{local}); err != nil {
		t.Fatalf("permitted local: %v", err)
	}
	for _, s := range []string{"8.8.8.8", "2606:4700::1111", "100.128.0.1"} {
		if err := CheckAddr(netip.MustParseAddr(s), nil, nil); err != nil {
			t.Errorf("public %s: %v", s, err)
		}
	}
}

func TestCheckAddrEmbeddedIPv4(t *testing.T) {
	cases := []struct {
		addr   string
		permit []netip.Prefix
		refuse bool
	}{
		{"::a9fe:a9fe", nil, true},
		{"::a9fe:a9fe", pfx("::/0"), true},
		{"64:ff9b::a9fe:a9fe", pfx("169.254.0.0/16"), true},
		{"2002:a9fe:a9fe::", pfx("169.254.0.0/16"), true},
		{"64:ff9b::a00:1", nil, true},
		{"64:ff9b::a00:1", pfx("10.0.0.0/8"), false},
		{"64:ff9b:1::a00:1", nil, true},
		{"2002:0a00:0001::", nil, true},
		{"2002:7f00:1::", nil, true},
		{"fec0::1", nil, true},
		{"fec0::1", pfx("fec0::/10"), true},
		{"64:ff9b::808:808", nil, false},
		{"2002:808:808::", nil, false},
	}
	for _, c := range cases {
		err := CheckAddr(netip.MustParseAddr(c.addr), c.permit, nil)
		if c.refuse != errors.Is(err, ErrPrivate) {
			t.Errorf("%s: err=%v refuse=%v", c.addr, err, c.refuse)
		}
	}
	if err := CheckAddr(netip.MustParseAddr("64:ff9b::cb00:7109"), nil, []netip.Addr{netip.MustParseAddr("203.0.113.9")}); !errors.Is(err, ErrPrivate) {
		t.Errorf("embedded local: %v", err)
	}
}

func TestCheckAddrZonedLocal(t *testing.T) {
	local := []netip.Addr{netip.MustParseAddr("2001:db8::1")}
	if err := CheckAddr(netip.MustParseAddr("2001:db8::1%eth0"), nil, local); !errors.Is(err, ErrPrivate) {
		t.Fatalf("zoned local: %v", err)
	}
	if err := CheckAddr(netip.MustParseAddr("2001:db8::1"), nil, []netip.Addr{netip.MustParseAddr("2001:db8::1%eth0")}); !errors.Is(err, ErrPrivate) {
		t.Fatalf("zoned entry: %v", err)
	}
}

// Cloud metadata endpoints outside 169.254/16 are refused whatever PERMIT_CIDRS says: an
// operator permitting fd00::/8 for an internal service, or 100.64/10, must not thereby open the
// instance's credentials; and Azure's WireServer is a PUBLIC address, so no permit is even
// needed to reach it -- any allowlisted name resolving there would. (#583 review)
func TestCheckAddrAlwaysRefusesCloudMetadataOutsideLinkLocal(t *testing.T) {
	everything := []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}
	for _, s := range []string{
		"fd00:ec2::254",        // AWS IMDS over IPv6 (in fc00::/7)
		"168.63.129.16",        // Azure WireServer (public)
		"100.100.100.200",      // Alibaba Cloud metadata (in 100.64/10)
		"::ffff:168.63.129.16", // v4-mapped
		"64:ff9b::a83f:8110",   // NAT64 embedding 168.63.129.16
		"2002:a83f:8110::1",    // 6to4 embedding 168.63.129.16
	} {
		if err := CheckAddr(netip.MustParseAddr(s), everything, nil); !errors.Is(err, ErrPrivate) {
			t.Errorf("CheckAddr(%s) with a permit-everything list = %v, want ErrPrivate", s, err)
		}
	}
}

// IANA special-purpose ranges that are not globally reachable are treated like private space:
// refused by default, dialable only through an explicit permit.
func TestCheckAddrRefusesSpecialPurposeRangesByDefault(t *testing.T) {
	for _, s := range []string{
		"198.18.0.1",   // benchmarking, 198.18.0.0/15
		"192.0.0.8",    // IETF protocol assignments, 192.0.0.0/24
		"240.0.0.1",    // reserved, 240.0.0.0/4
		"192.0.2.1",    // TEST-NET-1
		"198.51.100.1", // TEST-NET-2
		"203.0.113.1",  // TEST-NET-3
		"2001:db8::1",  // documentation
		"100::1",       // discard-only, 100::/64
	} {
		a := netip.MustParseAddr(s)
		if err := CheckAddr(a, nil, nil); !errors.Is(err, ErrPrivate) {
			t.Errorf("CheckAddr(%s) = %v, want ErrPrivate", s, err)
		}
		if err := CheckAddr(a, []netip.Prefix{netip.PrefixFrom(a, a.BitLen())}, nil); err != nil {
			t.Errorf("CheckAddr(%s) with it permitted = %v, want nil", s, err)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "140.82.113.6"} {
		if err := CheckAddr(netip.MustParseAddr(s), nil, nil); err != nil {
			t.Errorf("CheckAddr(%s) = %v, want nil (public)", s, err)
		}
	}
}

// SIIT (::ffff:0:a.b.c.d, RFC 6145) and Teredo (2001::/32, client IPv4 stored inverted in the
// last 32 bits) embed an IPv4 address that is judged as if dialled directly.
func TestCheckAddrUnwrapsSIITAndTeredo(t *testing.T) {
	for _, tc := range []struct {
		s   string
		bad bool
	}{
		{"::ffff:0:a00:1", true},                        // SIIT embedding 10.0.0.1
		{"::ffff:0:a9fe:a9fe", true},                    // SIIT embedding 169.254.169.254
		{"::ffff:0:808:808", false},                     // SIIT embedding 8.8.8.8
		{"2001:0:4136:e378:8000:63bf:f5ff:fffe", true},  // Teredo, client ^0xffffffff = 10.0.0.1
		{"2001:0:4136:e378:8000:63bf:f7f7:f7f7", false}, // Teredo, client 8.8.8.8
	} {
		err := CheckAddr(netip.MustParseAddr(tc.s), nil, nil)
		if tc.bad && !errors.Is(err, ErrPrivate) {
			t.Errorf("CheckAddr(%s) = %v, want ErrPrivate", tc.s, err)
		}
		if !tc.bad && err != nil {
			t.Errorf("CheckAddr(%s) = %v, want nil", tc.s, err)
		}
	}
}
