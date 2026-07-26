package cluster

import (
	"context"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PodSummary is the compact, UI-friendly view of a pod: enough to render a row
// and a status badge without shipping the whole pod object to the frontend.
type PodSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Node      string `json:"node"`
	Phase     string `json:"phase"`    // Running, Pending, Succeeded…
	Status    string `json:"status"`   // the human status a `kubectl get` shows (e.g. CrashLoopBackOff)
	Ready     string `json:"ready"`    // "1/2"
	Restarts  int32  `json:"restarts"` // total container restarts
	Healthy   bool   `json:"healthy"`  // a quick "is this pod fine?" for the UI
	Age       string `json:"age"`      // human age, e.g. "3d"
}

// NodeSummary is the compact view of a node.
type NodeSummary struct {
	Name    string `json:"name"`
	Ready   bool   `json:"ready"`
	Roles   string `json:"roles"`
	Version string `json:"version"`
	Age     string `json:"age"`
}

// Pods lists pods across all namespaces (or one, if ns != ""), shaped for the
// UI and sorted unhealthy-first so problems surface at the top.
func (c *Client) Pods(ctx context.Context, ns string) ([]PodSummary, error) {
	list, err := c.Kube.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]PodSummary, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, summarizePod(&list.Items[i]))
	}
	// Unhealthy first, then by namespace/name for a stable order.
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Healthy != out[b].Healthy {
			return !out[a].Healthy // unhealthy (false) sorts first
		}
		if out[a].Namespace != out[b].Namespace {
			return out[a].Namespace < out[b].Namespace
		}
		return out[a].Name < out[b].Name
	})
	return out, nil
}

// Nodes lists nodes shaped for the UI.
func (c *Client) Nodes(ctx context.Context) ([]NodeSummary, error) {
	list, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]NodeSummary, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, summarizeNode(&list.Items[i]))
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out, nil
}

// summarizePod computes the compact view, including the "status" string a user
// recognizes from `kubectl get pods` (CrashLoopBackOff, ImagePullBackOff…),
// which the health module will later diagnose.
func summarizePod(p *corev1.Pod) PodSummary {
	ready, total := 0, len(p.Spec.Containers)
	var restarts int32
	status := string(p.Status.Phase)

	// A container waiting/terminated reason (e.g. CrashLoopBackOff) is the
	// status a user actually sees; it wins over the coarse phase.
	for _, cs := range p.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if cs.Ready {
			ready++
		}
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			status = cs.State.Waiting.Reason
		} else if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" && cs.State.Terminated.Reason != "Completed" {
			status = cs.State.Terminated.Reason
		}
	}
	if p.DeletionTimestamp != nil {
		status = "Terminating"
	}

	healthy := p.Status.Phase == corev1.PodRunning && ready == total && total > 0
	if p.Status.Phase == corev1.PodSucceeded {
		healthy = true // a completed job pod is fine
	}

	return PodSummary{
		Name:      p.Name,
		Namespace: p.Namespace,
		Node:      p.Spec.NodeName,
		Phase:     string(p.Status.Phase),
		Status:    status,
		Ready:     itoa(ready) + "/" + itoa(total),
		Restarts:  restarts,
		Healthy:   healthy,
		Age:       age(p.CreationTimestamp.Time),
	}
}

func summarizeNode(n *corev1.Node) NodeSummary {
	ready := false
	for _, cond := range n.Status.Conditions {
		if cond.Type == corev1.NodeReady {
			ready = cond.Status == corev1.ConditionTrue
		}
	}
	roles := nodeRoles(n)
	return NodeSummary{
		Name:    n.Name,
		Ready:   ready,
		Roles:   roles,
		Version: n.Status.NodeInfo.KubeletVersion,
		Age:     age(n.CreationTimestamp.Time),
	}
}
