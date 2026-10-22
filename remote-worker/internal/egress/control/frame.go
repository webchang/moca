//go:build unix

package control

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/proto"
)

var errFrameTooLarge = errors.New("egress control: frame exceeds 64 KiB")

// maxFDsPerRead bounds the fds accepted on one receive. A well-formed Register carries one;
// the headroom lets us receive and close surplus fds instead of the kernel dropping them
// silently.
const maxFDsPerRead = 8

// writeFrame sends msg as one frame. If fd >= 0 it rides as SCM_RIGHTS on the sendmsg that
// carries the frame's first byte, which is the pairing readFrame relies on.
func writeFrame(c *net.UnixConn, msg proto.Message, fd int) error {
	body, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	if len(body) > maxFrame {
		return errFrameTooLarge
	}
	buf := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(buf, uint32(len(body)))
	copy(buf[4:], body)

	var oob []byte
	if fd >= 0 {
		oob = unix.UnixRights(fd)
	}
	n, _, err := c.WriteMsgUnix(buf, oob, nil)
	if err != nil {
		return err
	}
	// A stream sendmsg may be partial; the fd was attached to byte 0 and has been sent.
	for n < len(buf) {
		m, err := c.Write(buf[n:])
		if err != nil {
			return err
		}
		n += m
	}
	return nil
}

// readFrame returns one frame body and every fd received while reading it. The caller owns
// the fds (they are raw ints, close-on-exec) and must close those it does not use.
func readFrame(c *net.UnixConn) (body []byte, fds []int, err error) {
	defer func() {
		if err != nil {
			closeFDs(fds)
			fds = nil
		}
	}()
	var hdr [4]byte
	if err = readFull(c, hdr[:], &fds); err != nil {
		return nil, fds, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > maxFrame {
		return nil, fds, errFrameTooLarge
	}
	body = make([]byte, n)
	if err = readFull(c, body, &fds); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, fds, err
	}
	return body, fds, nil
}

// readFull fills p, collecting fds from the ancillary data of every receive, since the
// kernel may split a frame across reads and the fd arrives with whichever read covers
// its byte.
func readFull(c *net.UnixConn, p []byte, fds *[]int) error {
	oob := make([]byte, unix.CmsgSpace(4*maxFDsPerRead))
	for off := 0; off < len(p); {
		n, oobn, flags, _, err := c.ReadMsgUnix(p[off:], oob)
		if oobn > 0 {
			msgs, perr := unix.ParseSocketControlMessage(oob[:oobn])
			if perr != nil {
				return fmt.Errorf("parse control message: %w", perr)
			}
			for i := range msgs {
				rights, perr := unix.ParseUnixRights(&msgs[i])
				if perr != nil {
					continue // not SCM_RIGHTS
				}
				for _, fd := range rights {
					// net's ReadMsgUnix cannot pass MSG_CMSG_CLOEXEC, so there is a short window
					// between the receive and this call in which a concurrent fork+exec could
					// inherit the fd. Accepted: moca-egress execs nothing on this path.
					unix.CloseOnExec(fd)
				}
				*fds = append(*fds, rights...)
			}
		}
		if flags&unix.MSG_CTRUNC != 0 {
			return errors.New("egress control: ancillary data truncated")
		}
		off += n
		if err != nil {
			return err
		}
	}
	return nil
}

func closeFDs(fds []int) {
	for _, fd := range fds {
		_ = unix.Close(fd)
	}
}
