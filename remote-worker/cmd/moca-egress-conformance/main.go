//go:build unix

// Command moca-egress-conformance runs the public moca-egress conformance
// suite (package egress/conformance, MI1 section 12.3) against a binary that
// implements the contract. It prints "PASS <name>" or "FAIL <name>: <err>"
// per case and exits non-zero if any case fails.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/rossoctl/moca/remote-worker/egress/conformance"
)

func main() {
	bin := flag.String("bin", "", "path of the moca-egress binary under test")
	run := flag.String("run", "", "run only the case with this name")
	timeout := flag.Duration("timeout", 60*time.Second, "bound on each case")
	flag.Parse()
	if *bin == "" {
		fmt.Fprintln(os.Stderr, "moca-egress-conformance: -bin is required")
		flag.Usage()
		os.Exit(2)
	}
	t := conformance.ProcessTarget{Bin: *bin}
	failed, ran := 0, 0
	for _, c := range conformance.Cases() {
		if *run != "" && c.Name != *run {
			continue
		}
		ran++
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		err := c.Run(ctx, t)
		cancel()
		if err != nil {
			failed++
			fmt.Printf("FAIL %s: %v\n", c.Name, err)
		} else {
			fmt.Printf("PASS %s\n", c.Name)
		}
	}
	if ran == 0 {
		fmt.Fprintf(os.Stderr, "moca-egress-conformance: no case named %q\n", *run)
		os.Exit(2)
	}
	if failed > 0 {
		os.Exit(1)
	}
}
