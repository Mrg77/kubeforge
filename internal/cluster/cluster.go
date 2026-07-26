// Package cluster owns KubeForge's connection to a Kubernetes cluster. It reads
// a kubeconfig and builds the typed clients the rest of the app uses.
//
// SAFETY — an explicit, deliberate connection, never a surprise one:
// KubeForge connects to the context you name (or the kubeconfig's current
// context), and it does that only when you ask. It never probes clusters in the
// background. This matters because on some machines the default context points
// at a real production cluster behind SSO/OIDC, and merely touching it can
// trigger a login. So the connection is always caller-driven and the active
// context is surfaced to the user, never hidden.
package cluster

import (
	"context"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Client bundles the typed clients KubeForge talks to a cluster with, plus the
// human-readable identity of what it's connected to.
type Client struct {
	// Kube is the core Kubernetes API client (pods, nodes, events…).
	Kube kubernetes.Interface
	// Metrics is the metrics.k8s.io client (CPU/memory usage), used for the
	// FinOps and optimization views. It may be nil if metrics-server isn't
	// installed — that's a soft, reported condition, not a fatal error.
	Metrics metricsv.Interface

	// Context is the kubeconfig context name we connected through, surfaced so
	// the UI can always show "you are looking at <this cluster>".
	Context string
	// Server is the API server URL, also surfaced for transparency.
	Server string

	// dyn provides discovery + dynamic access, so KubeForge can list ANY
	// resource kind (including CRDs on a self-managed cluster), not only the
	// typed built-ins.
	dyn *dyn
}

// Options controls how Connect builds the client.
type Options struct {
	// Kubeconfig is the path to the kubeconfig file. Empty means the standard
	// resolution (KUBECONFIG env, then ~/.kube/config).
	Kubeconfig string
	// Context is the kubeconfig context to use. Empty means the file's
	// current-context. Naming it explicitly is the safe default for scripts.
	Context string
}

// Connect builds a Client from the given options. It resolves the kubeconfig,
// selects the named (or current) context, and constructs the typed clients. It
// does NOT make a network call yet — connection is verified lazily via Ping —
// so building a Client can't itself trigger an auth prompt.
func Connect(opts Options) (*Client, error) {
	loadRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if opts.Kubeconfig != "" {
		loadRules.ExplicitPath = opts.Kubeconfig
	}
	overrides := &clientcmd.ConfigOverrides{}
	if opts.Context != "" {
		overrides.CurrentContext = opts.Context
	}
	cfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadRules, overrides)

	restCfg, err := cfg.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("loading kubeconfig: %w", err)
	}
	// A tight timeout so a wrong/unreachable server fails fast instead of
	// hanging the whole app.
	restCfg.Timeout = 15 * time.Second

	kube, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("building kubernetes client: %w", err)
	}

	// metrics-server is optional; a failure to build its client is not fatal.
	var metrics metricsv.Interface
	if m, err := metricsv.NewForConfig(restCfg); err == nil {
		metrics = m
	}

	// Discovery + dynamic clients power the "browse any resource" catalog.
	// A failure here is non-fatal: the typed views still work.
	dynClients, _ := withDynamic(restCfg)

	ctxName, server := describeConnection(cfg, restCfg)
	return &Client{Kube: kube, Metrics: metrics, Context: ctxName, Server: server, dyn: dynClients}, nil
}

// Ping verifies the connection actually works (and, on an OIDC cluster, this is
// the call that would trigger a login — so it happens only when the user has
// chosen to connect, never in the background). It returns the server version on
// success.
func (c *Client) Ping(ctx context.Context) (string, error) {
	v, err := c.Kube.Discovery().ServerVersion()
	if err != nil {
		return "", fmt.Errorf("cannot reach the cluster: %w", err)
	}
	return v.GitVersion, nil
}

// HasMetrics reports whether the metrics API is available, checked lazily.
func (c *Client) HasMetrics(ctx context.Context) bool {
	if c.Metrics == nil {
		return false
	}
	_, err := c.Metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{Limit: 1})
	return err == nil
}

// describeConnection extracts the context name and server URL for display.
func describeConnection(cfg clientcmd.ClientConfig, restCfg *rest.Config) (string, string) {
	name := ""
	if raw, err := cfg.RawConfig(); err == nil {
		name = raw.CurrentContext
	}
	return name, restCfg.Host
}
