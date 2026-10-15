//go:build !linux

package guestagent

import "errors"

// BringUpLoopback is unavailable off Linux. The agent only ever runs in a Linux guest; this
// exists so the package builds and its tests run on a developer's macOS laptop.
func BringUpLoopback() error { return errors.New("bringing up lo is Linux-only") }
