//go:build unix

package conformance

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"os/exec"
	"sort"
	"sync"
	"syscall"
	"time"
)

const (
	// startBound bounds how long a target may take to accept on its control
	// socket.
	startBound = 10 * time.Second
	// stopGrace is how long Stop waits after SIGTERM before SIGKILL.
	stopGrace = 5 * time.Second
	// stderrKeep bounds the stderr kept for error messages.
	stderrKeep = 16 << 10
)

// ProcessTarget runs an implementation as a separate process: Bin is exec'd
// with exactly the case's env (nothing is inherited), audit JSON lines are
// read from its stdout, and its control socket is expected at the path in
// MOCA_EGRESS_CONTROL_SOCK.
type ProcessTarget struct{ Bin string }

type processInstance struct {
	cmd    *exec.Cmd
	sock   string
	audit  <-chan map[string]any
	pump   <-chan struct{}
	exited chan struct{}
	err    error // cmd.Wait's result, set before exited closes
	stderr *tailBuffer

	once  sync.Once
	stopE error
}

// Start execs t.Bin and waits, boundedly, until its control socket accepts.
func (t ProcessTarget) Start(ctx context.Context, env map[string]string) (Instance, error) {
	sock := env[EnvControlSock]
	if sock == "" {
		return nil, fmt.Errorf("process target: %s is not set", EnvControlSock)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	cmd := exec.Command(t.Bin)
	cmd.Env = []string{}
	for _, k := range keys {
		cmd.Env = append(cmd.Env, k+"="+env[k])
	}
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	in := &processInstance{cmd: cmd, sock: sock, exited: make(chan struct{}), stderr: &tailBuffer{max: stderrKeep}}
	cmd.Stderr = in.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("process target: start %s: %w", t.Bin, err)
	}
	in.audit, in.pump = DecodeAudit(pr)
	go func() {
		in.err = cmd.Wait()
		_ = pw.Close()
		close(in.exited)
	}()

	deadline := time.Now().Add(startBound)
	for {
		var d net.Dialer
		dctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		c, err := d.DialContext(dctx, "unix", sock)
		cancel()
		if err == nil {
			_ = c.Close()
			return in, nil
		}
		select {
		case <-in.exited:
			<-in.pump
			return nil, fmt.Errorf("process target: %s exited before serving (%v); stderr: %s", t.Bin, in.err, in.stderr)
		default:
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			_ = in.Stop()
			return nil, fmt.Errorf("process target: control socket %s not accepting within %v: %v; stderr: %s",
				sock, startBound, err, in.stderr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (in *processInstance) ControlSocket() string        { return in.sock }
func (in *processInstance) Audit() <-chan map[string]any { return in.audit }

// Stop sends SIGTERM, waits up to five seconds, then sends SIGKILL. Needing
// the SIGKILL, or a non-zero exit, is reported as an error.
func (in *processInstance) Stop() error {
	in.once.Do(func() {
		select {
		case <-in.exited:
		default:
			_ = in.cmd.Process.Signal(syscall.SIGTERM)
			select {
			case <-in.exited:
			case <-time.After(stopGrace):
				_ = in.cmd.Process.Kill()
				<-in.exited
				in.stopE = fmt.Errorf("process target: no exit within %v of SIGTERM; killed; stderr: %s", stopGrace, in.stderr)
			}
		}
		<-in.pump
		if in.stopE == nil && in.err != nil {
			in.stopE = fmt.Errorf("process target: exit: %v; stderr: %s", in.err, in.stderr)
		}
	})
	return in.stopE
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   bytes.Buffer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b.Write(p)
	if over := t.b.Len() - t.max; over > 0 {
		t.b.Next(over)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.b.String()
}
