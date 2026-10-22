package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// ControlConfig configures the control socket.
type ControlConfig struct {
	Socket      string
	AllowedUIDs []int
}

const (
	defaultControlSock = "/run/moca-egress/control.sock"
	defaultMaxConns    = 32
	defaultMaxRequests = 10000
	envTenancy         = "MOCA_TENANCY"
	envAllow           = "MOCA_EGRESS_ALLOW"
	envPermit          = "MOCA_EGRESS_PERMIT_CIDRS"
	envResolver        = "MOCA_EGRESS_RESOLVER"
	envMaxConns        = "MOCA_EGRESS_MAX_CONNS_PER_VM"
	envMaxRequests     = "MOCA_EGRESS_MAX_REQUESTS_PER_SESSION"
	envControlSock     = "MOCA_EGRESS_CONTROL_SOCK"
	envControlUIDs     = "MOCA_EGRESS_CONTROL_UIDS"
)

// ConfigFromEnv builds the proxy and control configuration from environment
// variables read through get. Every error names its variable; the value of
// MOCA_EGRESS_PERMIT_CIDRS is never echoed.
func ConfigFromEnv(get func(string) string) (Config, ControlConfig, error) {
	var cfg Config
	var cc ControlConfig

	switch t := get(envTenancy); t {
	case "", "single":
	case "multi":
		return cfg, cc, fmt.Errorf("%s=multi: moca-egress is single-tenant only (MI1 S2)", envTenancy)
	default:
		return cfg, cc, fmt.Errorf("%s=%q: want unset or \"single\" (MI1 S2)", envTenancy, t)
	}

	allowRaw := strings.TrimSpace(get(envAllow))
	if allowRaw == "" {
		return cfg, cc, fmt.Errorf("%s is required", envAllow)
	}
	allow, err := ParseAllow(allowRaw)
	if err != nil {
		return cfg, cc, fmt.Errorf("%s: %w", envAllow, err)
	}
	cfg.Allow = allow

	for _, item := range strings.Split(get(envPermit), ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		p, err := netip.ParsePrefix(item)
		if err != nil {
			return cfg, cc, fmt.Errorf("%s: an item is not a valid CIDR", envPermit)
		}
		cfg.PermitCIDRs = append(cfg.PermitCIDRs, p)
	}

	if cfg.MaxConnsPerVM, err = positiveInt(get, envMaxConns, defaultMaxConns); err != nil {
		return cfg, cc, err
	}
	if cfg.MaxRequestsPerSession, err = positiveInt(get, envMaxRequests, defaultMaxRequests); err != nil {
		return cfg, cc, err
	}

	cfg.Resolver = net.DefaultResolver
	if hp := strings.TrimSpace(get(envResolver)); hp != "" {
		_, port, err := net.SplitHostPort(hp)
		if err != nil || port == "" {
			return cfg, cc, fmt.Errorf("%s=%q: want host:port", envResolver, hp)
		}
		cfg.Resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, hp)
		}}
	}
	cfg.LocalAddrs = localAddrs
	cfg.Credentials = NoCredentials{}
	cfg.Audit = NewJSONSink(os.Stdout)

	cc.Socket = get(envControlSock)
	if cc.Socket == "" {
		cc.Socket = defaultControlSock
	}
	if raw := strings.TrimSpace(get(envControlUIDs)); raw == "" {
		cc.AllowedUIDs = []int{0}
	} else {
		for _, item := range strings.Split(raw, ",") {
			item = strings.TrimSpace(item)
			uid, err := strconv.Atoi(item)
			if err != nil || uid < 0 {
				return cfg, cc, fmt.Errorf("%s: %q is not a non-negative integer", envControlUIDs, item)
			}
			cc.AllowedUIDs = append(cc.AllowedUIDs, uid)
		}
	}
	return cfg, cc, nil
}

func positiveInt(get func(string) string, name string, def int) (int, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q: want a positive integer", name, raw)
	}
	return n, nil
}

// localAddrs lists the host's interface addresses.
func localAddrs() ([]netip.Addr, error) {
	as, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, a := range as {
		s := a.String()
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Addr().Unmap())
		} else if ip, err := netip.ParseAddr(s); err == nil {
			out = append(out, ip.Unmap())
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no interface addresses")
	}
	return out, nil
}
