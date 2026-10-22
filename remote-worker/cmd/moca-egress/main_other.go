//go:build !unix

package main

import "log"

func main() {
	log.Fatal("moca-egress runs on unix only")
}
