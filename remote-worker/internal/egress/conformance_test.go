//go:build unix

package egress_test

import (
	"context"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/egress/conformance"
	"github.com/rossoctl/moca/remote-worker/internal/egress"
	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

// inProcessTarget runs moca-egress in this test process: a Proxy and a
// control.Server built from the env map exactly as the binary builds them,
// with the audit sink redirected to a pipe so that cases read audit lines the
// same way they read the binary's stdout.
type inProcessTarget struct{}

type inProcessInstance struct {
	sock  string
	srv   *control.Server
	proxy *egress.Proxy
	pw    *io.PipeWriter
	audit <-chan map[string]any
	pump  <-chan struct{}
	serve chan error
	once  sync.Once
	err   error
}

func (inProcessTarget) Start(_ context.Context, env map[string]string) (conformance.Instance, error) {
	cfg, cc, err := egress.ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil {
		return nil, err
	}
	pr, pw := io.Pipe()
	cfg.Audit = egress.NewJSONSink(pw)
	proxy, err := egress.NewProxy(cfg)
	if err != nil {
		return nil, err
	}
	srv, err := control.NewServer(cc.Socket, cc.AllowedUIDs, proxy)
	if err != nil {
		proxy.Close()
		return nil, err
	}
	in := &inProcessInstance{sock: cc.Socket, srv: srv, proxy: proxy, pw: pw, serve: make(chan error, 1)}
	in.audit, in.pump = conformance.DecodeAudit(pr)
	go func() { in.serve <- srv.Serve() }()
	return in, nil
}

func (in *inProcessInstance) ControlSocket() string        { return in.sock }
func (in *inProcessInstance) Audit() <-chan map[string]any { return in.audit }

// Stop shuts down as the binary does on SIGTERM: control server first, then
// the proxy, then the audit stream.
func (in *inProcessInstance) Stop() error {
	in.once.Do(func() {
		in.err = in.srv.Close()
		if err := <-in.serve; err != nil && in.err == nil {
			in.err = err
		}
		if err := in.proxy.Close(); err != nil && in.err == nil {
			in.err = err
		}
		_ = in.pw.Close()
		<-in.pump
	})
	return in.err
}

func TestConformance(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "moca-egress")
	if out, err := exec.Command("go", "build", "-o", bin,
		"github.com/rossoctl/moca/remote-worker/cmd/moca-egress").CombinedOutput(); err != nil {
		t.Fatalf("build moca-egress: %v\n%s", err, out)
	}
	targets := []struct {
		name string
		t    conformance.Target
	}{
		{"inprocess", inProcessTarget{}},
		{"process", conformance.ProcessTarget{Bin: bin}},
	}
	for _, tg := range targets {
		t.Run(tg.name, func(t *testing.T) {
			for _, c := range conformance.Cases() {
				t.Run(c.Name, func(t *testing.T) {
					ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
					defer cancel()
					if err := c.Run(ctx, tg.t); err != nil {
						t.Fatal(err)
					}
				})
			}
		})
	}
}
