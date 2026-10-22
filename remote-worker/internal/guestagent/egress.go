package guestagent

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// EgressForwarder is the guest side of the P4.1 egress transport (spec §4, §12.1):
// it accepts connections on a loopback TCP listener and opaquely byte-splices each
// one to the host over vsock. It deliberately does NOT use this package's framed
// protocol (protocol.go); the bytes are the client's HTTP proxy conversation.
type EgressForwarder struct {
	// Dial opens the upstream. Production: func() { return DialVsock(2, port) }.
	Dial func() (net.Conn, error)
	// Logf receives dial failures. nil means log.Printf.
	Logf func(format string, a ...any)
}

// Serve accepts on ln until it is closed, handling each connection concurrently.
func (f *EgressForwarder) Serve(ln net.Listener) error {
	var delay time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			// Transient (EMFILE, ENFILE, ...): guest code can trigger these by
			// exhausting fds, and this runs in PID 1, so back off and keep serving.
			if delay == 0 {
				delay = 5 * time.Millisecond
			} else if delay *= 2; delay > time.Second {
				delay = time.Second
			}
			f.logf("guest-agent: egress accept: %v; retrying in %v", err, delay)
			time.Sleep(delay)
			continue
		}
		delay = 0
		go f.handle(c)
	}
}

func (f *EgressForwarder) logf(format string, a ...any) {
	if f.Logf != nil {
		f.Logf(format, a...)
		return
	}
	log.Printf(format, a...)
}

func (f *EgressForwarder) handle(client net.Conn) {
	up, err := f.Dial()
	if err != nil {
		f.logf("guest-agent: egress dial: %v", err)
		body := "egress_unreachable: " + strings.ReplaceAll(err.Error(), "\n", " ") + "\n"
		fmt.Fprintf(client, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n"+
			"X-Moca-Egress-Error: egress_unreachable\r\nConnection: close\r\n"+
			"Content-Length: %d\r\n\r\n%s", len(body), body)
		// Half-close and briefly drain so a client that already sent its request
		// sees the 502 instead of an RST-induced ECONNRESET.
		if cw, ok := client.(closeWriter); ok {
			_ = cw.CloseWrite()
		}
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		_, _ = io.Copy(io.Discard, io.LimitReader(client, 64<<10))
		_ = client.Close()
		return
	}
	splice(client, up)
}

type closeWriter interface{ CloseWrite() error }

// splice copies both ways. On EOF in one direction the destination's write side is
// half-closed (or the destination closed, if it cannot half-close) and the reverse
// direction keeps flowing. A copy error tears down both conns at once.
func splice(a, b net.Conn) {
	var wg sync.WaitGroup
	var once sync.Once
	closeBoth := func() { _ = a.Close(); _ = b.Close() }
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		if err := copyConn(dst, src); err != nil {
			once.Do(closeBoth)
			return
		}
		if cw, ok := dst.(closeWriter); ok {
			if cw.CloseWrite() != nil {
				once.Do(closeBoth)
			}
		} else {
			_ = dst.Close()
		}
	}
	wg.Add(2)
	go pipe(a, b)
	go pipe(b, a)
	wg.Wait()
	once.Do(closeBoth)
}

func copyConn(dst, src net.Conn) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
