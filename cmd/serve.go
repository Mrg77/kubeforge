package cmd

import (
	"fmt"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/Mrg77/kubeforge/internal/api"
	"github.com/Mrg77/kubeforge/internal/cluster"
	"github.com/Mrg77/kubeforge/internal/web"
	webui "github.com/Mrg77/kubeforge/web"
)

var (
	serveKubeconfig string
	serveContext    string
	serveHost       string
	servePort       int
	serveNoOpen     bool
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the KubeForge web console against your cluster",
	Long: `Connect to your Kubernetes cluster and open the KubeForge web console in
your browser. By default it binds to localhost only — nothing is exposed to the
network.

  kubeforge serve                          # current kubeconfig context, localhost
  kubeforge serve --context my-cluster     # a specific context
  kubeforge serve --host 0.0.0.0 --port 8080   # expose to a team (add auth/TLS!)`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := cluster.Connect(cluster.Options{
			Kubeconfig: serveKubeconfig,
			Context:    serveContext,
		})
		if err != nil {
			return err
		}
		fmt.Printf("Connecting to context %q (%s)…\n", c.Context, c.Server)

		srv := web.New(web.Config{
			Host: serveHost,
			Port: servePort,
			Open: !serveNoOpen,
			UI:   webui.Dist(), // the embedded frontend (may be empty until built)
		}, api.New(c).Routes())

		ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		return srv.Serve(ctx)
	},
}

func init() {
	serveCmd.Flags().StringVar(&serveKubeconfig, "kubeconfig", "", "path to the kubeconfig (default: $KUBECONFIG, then ~/.kube/config)")
	serveCmd.Flags().StringVar(&serveContext, "context", "", "kubeconfig context to use (default: the file's current context)")
	serveCmd.Flags().StringVar(&serveHost, "host", "127.0.0.1", "host to bind (127.0.0.1 = local only)")
	serveCmd.Flags().IntVar(&servePort, "port", 7777, "port to listen on (0 = pick a free one)")
	serveCmd.Flags().BoolVar(&serveNoOpen, "no-open", false, "don't open the browser automatically")
	rootCmd.AddCommand(serveCmd)
}
