package cluster

import (
	"context"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CloudProvider is the detected hosting environment, inferred from the nodes'
// providerID and well-known labels. It drives the FinOps price defaults and lets
// the UI be honest about whether costs are real-cloud-shaped or just estimates.
type CloudProvider struct {
	// ID is a stable machine key: "aws" | "gcp" | "azure" | "digitalocean" |
	// "local" | "unknown".
	ID string `json:"id"`
	// Label is a human name for the UI ("Amazon EKS", "Local (kind)"…).
	Label string `json:"label"`
	// Local is true for kind/minikube/k3d/docker-desktop — clusters with no real
	// billing, where any cost is an illustrative estimate, not a bill.
	Local bool `json:"local"`
	// Region, if the nodes expose topology.kubernetes.io/region.
	Region string `json:"region,omitempty"`
	// InstanceType of a sampled node, if labeled (helps explain the estimate).
	InstanceType string `json:"instanceType,omitempty"`
}

// DetectProvider reads the nodes to infer where the cluster runs. It's
// best-effort and read-only; on any error it returns an "unknown" provider so
// callers can fall back to default pricing.
func (c *Client) DetectProvider(ctx context.Context) CloudProvider {
	nodes, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{Limit: 5})
	if err != nil || len(nodes.Items) == 0 {
		return CloudProvider{ID: "unknown", Label: "Unknown"}
	}
	n := &nodes.Items[0]
	pid := n.Spec.ProviderID
	labels := n.Labels
	region := labels["topology.kubernetes.io/region"]
	instance := labels["node.kubernetes.io/instance-type"]

	switch {
	case strings.HasPrefix(pid, "aws://"):
		return CloudProvider{ID: "aws", Label: "Amazon EKS", Region: region, InstanceType: instance}
	case strings.HasPrefix(pid, "gce://"):
		return CloudProvider{ID: "gcp", Label: "Google GKE", Region: region, InstanceType: instance}
	case strings.HasPrefix(pid, "azure://"):
		return CloudProvider{ID: "azure", Label: "Azure AKS", Region: region, InstanceType: instance}
	case strings.HasPrefix(pid, "digitalocean://"):
		return CloudProvider{ID: "digitalocean", Label: "DigitalOcean", Region: region, InstanceType: instance}
	case strings.HasPrefix(pid, "kind://"),
		strings.HasPrefix(pid, "k3s://"),
		strings.Contains(pid, "docker"):
		return CloudProvider{ID: "local", Label: localLabel(pid), Local: true}
	case pid == "":
		// No providerID at all — usually a self-managed / bare-metal cluster, or
		// a local one without a cloud controller. Treat as local-ish estimate.
		return CloudProvider{ID: "local", Label: "Self-managed / local", Local: true}
	default:
		return CloudProvider{ID: "unknown", Label: "Unknown", Region: region, InstanceType: instance}
	}
}

func localLabel(pid string) string {
	switch {
	case strings.HasPrefix(pid, "kind://"):
		return "Local (kind)"
	case strings.HasPrefix(pid, "k3s://"):
		return "Local (k3s)"
	default:
		return "Local"
	}
}
