//go:build !unix

package main

import "log"

func main() {
	log.Fatal("moca-egress-conformance runs on unix only")
}
