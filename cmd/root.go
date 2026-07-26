package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// version is injected at build time via ldflags.
var version = "dev"

var rootCmd = &cobra.Command{
	Use:   "kubeforge",
	Short: "A local-first web console to understand and optimize your Kubernetes cluster",
	Long: `KubeForge is a single binary that opens a web console for your Kubernetes
cluster: what's healthy, why a pod is broken, where you're wasting money, and
what to tune. It runs locally against your kubeconfig — nothing is exposed to
the network unless you deliberately choose to expose it.`,
	Version:       version,
	SilenceUsage:  true,
	SilenceErrors: true,
}

// Execute runs the CLI.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "kubeforge: "+err.Error())
		os.Exit(1)
	}
}
