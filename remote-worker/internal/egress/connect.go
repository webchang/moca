package egress

import (
	"bufio"
	"io"
	"net"
	"sync"
	"sync/atomic"
)

const connectEstablished = "HTTP/1.1 200 Connection Established\r\n\r\n"

type closeWriter interface{ CloseWrite() error }

// tunnel answers a checked CONNECT and splices opaquely until both directions
// end. Bytes the guest sent behind the CONNECT request, already buffered in
// br, go upstream first because the guest side is read through br.
func (pc *proxyConn) tunnel(up net.Conn, br *bufio.Reader, ev Event) {
	var bytesUp, bytesDown atomic.Int64
	if _, err := io.WriteString(pc.c, connectEstablished); err == nil {
		splice(pc.c, br, up, &bytesUp, &bytesDown)
	}
	ev.Status, ev.Decision = 200, DecisionTunnel
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, true) // suppressed if Unregister aborted the conn
}

// splice copies client→up (reading through cr) and up→client. On EOF in one
// direction the destination's write side is half-closed (or the destination
// closed, if it cannot half-close) and the other direction keeps flowing. A
// copy error tears both conns down. It mirrors the guest forwarder's splice.
func splice(client net.Conn, cr io.Reader, up net.Conn, nUp, nDown *atomic.Int64) {
	var wg sync.WaitGroup
	var once sync.Once
	closeBoth := func() { _ = client.Close(); _ = up.Close() }
	pipe := func(dst net.Conn, src io.Reader, n *atomic.Int64) {
		defer wg.Done()
		if err := copyCounted(dst, src, n); err != nil {
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
	go pipe(up, cr, nUp)
	go pipe(client, up, nDown)
	wg.Wait()
	once.Do(closeBoth)
}

func copyCounted(dst io.Writer, src io.Reader, n *atomic.Int64) error {
	buf := make([]byte, 32*1024)
	for {
		r, err := src.Read(buf)
		if r > 0 {
			w, werr := dst.Write(buf[:r])
			n.Add(int64(w))
			if werr != nil {
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
