package egress

import (
	"strings"
	"testing"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestConfigRequiresAllow(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(nil))
	if err == nil || !strings.Contains(err.Error(), "MOCA_EGRESS_ALLOW") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigRefusesMultiTenancy(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "multi", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err == nil || !strings.Contains(err.Error(), "MI1 S2") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigRefusesUnknownTenancy(t *testing.T) {
	_, _, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "multiple", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err == nil || !strings.Contains(err.Error(), "MOCA_TENANCY") || !strings.Contains(err.Error(), "multiple") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigDefaults(t *testing.T) {
	cfg, cc, err := ConfigFromEnv(envMap(map[string]string{"MOCA_TENANCY": "single", "MOCA_EGRESS_ALLOW": "a.example:443"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConnsPerVM != 32 || cfg.MaxRequestsPerSession != 10000 {
		t.Fatalf("caps = %d, %d", cfg.MaxConnsPerVM, cfg.MaxRequestsPerSession)
	}
	if cc.Socket != "/run/moca-egress/control.sock" {
		t.Fatalf("socket = %q", cc.Socket)
	}
	if len(cc.AllowedUIDs) != 1 || cc.AllowedUIDs[0] != 0 {
		t.Fatalf("uids = %v", cc.AllowedUIDs)
	}
	if len(cfg.Allow) != 1 || cfg.Resolver == nil || cfg.LocalAddrs == nil || cfg.Audit == nil || cfg.Credentials == nil {
		t.Fatalf("cfg incomplete: %+v", cfg)
	}
}

func TestConfigParsesOverrides(t *testing.T) {
	cfg, cc, err := ConfigFromEnv(envMap(map[string]string{
		"MOCA_EGRESS_ALLOW":                    "a.example:443",
		"MOCA_EGRESS_PERMIT_CIDRS":             " 10.0.0.0/8, ,127.0.0.1/32",
		"MOCA_EGRESS_RESOLVER":                 "127.0.0.1:5353",
		"MOCA_EGRESS_MAX_CONNS_PER_VM":         "4",
		"MOCA_EGRESS_MAX_REQUESTS_PER_SESSION": "7",
		"MOCA_EGRESS_CONTROL_SOCK":             "/tmp/x.sock",
		"MOCA_EGRESS_CONTROL_UIDS":             "0, 1000",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PermitCIDRs) != 2 || cfg.MaxConnsPerVM != 4 || cfg.MaxRequestsPerSession != 7 {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cc.Socket != "/tmp/x.sock" || len(cc.AllowedUIDs) != 2 || cc.AllowedUIDs[1] != 1000 {
		t.Fatalf("cc = %+v", cc)
	}
}

func TestConfigRejectsBadCIDRAndBadUID(t *testing.T) {
	base := func() map[string]string { return map[string]string{"MOCA_EGRESS_ALLOW": "a.example:443"} }
	cases := map[string]string{
		"MOCA_EGRESS_PERMIT_CIDRS":             "not-a-cidr",
		"MOCA_EGRESS_CONTROL_UIDS":             "-1",
		"MOCA_EGRESS_MAX_CONNS_PER_VM":         "0",
		"MOCA_EGRESS_MAX_REQUESTS_PER_SESSION": "abc",
		"MOCA_EGRESS_RESOLVER":                 "nohostport",
	}
	for k, v := range cases {
		m := base()
		m[k] = v
		_, _, err := ConfigFromEnv(envMap(m))
		if err == nil || !strings.Contains(err.Error(), k) {
			t.Errorf("%s=%q: err = %v", k, v, err)
		}
		if k == "MOCA_EGRESS_PERMIT_CIDRS" && err != nil && strings.Contains(err.Error(), v) {
			t.Errorf("error leaks permit value: %v", err)
		}
	}
	m := base()
	m["MOCA_EGRESS_CONTROL_UIDS"] = "x"
	if _, _, err := ConfigFromEnv(envMap(m)); err == nil {
		t.Error("non-numeric uid accepted")
	}
}
