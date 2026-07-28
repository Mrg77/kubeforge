package cluster

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// Topology is a compact graph of the cluster's shape: nodes, the pods on each
// node, and the services fronting those pods. It's what the topology view
// draws — the "how is my cluster wired" picture that TUIs (k9s) can't show and
// resource browsers (Headlamp) don't.
type Topology struct {
	Nodes    []TopoNode    `json:"nodes"`
	Services []TopoService `json:"services"`
}

// TopoNode is a node and the pods scheduled on it.
type TopoNode struct {
	Name  string    `json:"name"`
	Ready bool      `json:"ready"`
	Pods  []TopoPod `json:"pods"`
}

// TopoPod is a pod in the graph, with enough to color it by health and group it
// by its owning workload (so views can render Deployment/StatefulSet/… clusters
// rather than a wall of anonymous pods).
type TopoPod struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Healthy   bool   `json:"healthy"`
	Status    string `json:"status"`
	// Owner is the controlling workload ("web", "postgres"…), derived from the
	// pod's ownerReferences (a Deployment shows through its ReplicaSet). Falls
	// back to the pod name when a pod is standalone.
	Owner string `json:"owner"`
	// OwnerKind is Deployment/StatefulSet/DaemonSet/Job/ReplicaSet/Pod.
	OwnerKind string `json:"ownerKind"`
	// Restarts is the pod's total container restart count — a health signal the
	// heatmap tooltip surfaces.
	Restarts int32 `json:"restarts"`
}

// TopoService is a service and the pod keys (namespace/name) it selects, so the
// UI can draw service→pod edges.
type TopoService struct {
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Type      string   `json:"type"`
	PodKeys   []string `json:"podKeys"`
}

// workloadOf resolves the workload a pod belongs to from its ownerReferences.
// A Deployment owns a ReplicaSet which owns the pod, so for a ReplicaSet owner
// we strip the RS's trailing hash to recover the Deployment name
// ("web-7d4f9c" -> "web"). Standalone pods return their own name.
func workloadOf(p *corev1.Pod) (name, kind string) {
	for _, ref := range p.OwnerReferences {
		if ref.Controller == nil || !*ref.Controller {
			continue
		}
		switch ref.Kind {
		case "ReplicaSet":
			// RS name is "<deployment>-<podtemplatehash>"; drop the last segment.
			if idx := lastDash(ref.Name); idx > 0 {
				return ref.Name[:idx], "Deployment"
			}
			return ref.Name, "ReplicaSet"
		case "StatefulSet", "DaemonSet", "Job":
			return ref.Name, ref.Kind
		default:
			return ref.Name, ref.Kind
		}
	}
	return p.Name, "Pod"
}

func lastDash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '-' {
			return i
		}
	}
	return -1
}

// BuildTopology assembles the graph. It's read-only and bounded to the given
// namespace ("" = all). It caps pods per node in the summary is left to the UI;
// here we return the full picture the frontend can lay out or trim.
func (c *Client) BuildTopology(ctx context.Context, ns string) (*Topology, error) {
	topo := &Topology{Nodes: []TopoNode{}, Services: []TopoService{}}

	nodeList, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	podList, err := c.Kube.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	// Group pods by node.
	podsByNode := map[string][]TopoPod{}
	// Keep the label sets so we can match services to pods.
	podLabels := map[string]map[string]string{} // key ns/name -> labels
	for i := range podList.Items {
		p := &podList.Items[i]
		sum := summarizePod(p)
		owner, ownerKind := workloadOf(p)
		var restarts int32
		for _, cs := range p.Status.ContainerStatuses {
			restarts += cs.RestartCount
		}
		tp := TopoPod{
			Name: p.Name, Namespace: p.Namespace, Healthy: sum.Healthy, Status: sum.Status,
			Owner: owner, OwnerKind: ownerKind, Restarts: restarts,
		}
		node := p.Spec.NodeName
		if node == "" {
			node = "(unscheduled)"
		}
		podsByNode[node] = append(podsByNode[node], tp)
		podLabels[p.Namespace+"/"+p.Name] = p.Labels
	}

	for i := range nodeList.Items {
		n := &nodeList.Items[i]
		ready := false
		for _, cond := range n.Status.Conditions {
			if cond.Type == corev1.NodeReady {
				ready = cond.Status == corev1.ConditionTrue
			}
		}
		topo.Nodes = append(topo.Nodes, TopoNode{Name: n.Name, Ready: ready, Pods: podsByNode[n.Name]})
	}
	// Unscheduled pods, if any, get a virtual node so nothing is hidden.
	if up := podsByNode["(unscheduled)"]; len(up) > 0 {
		topo.Nodes = append(topo.Nodes, TopoNode{Name: "(unscheduled)", Ready: false, Pods: up})
	}

	// Services → the pods their selector matches.
	svcList, err := c.Kube.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err == nil {
		for i := range svcList.Items {
			s := &svcList.Items[i]
			if len(s.Spec.Selector) == 0 {
				continue // headless/externalName without a selector: no pod edges
			}
			sel := labels.SelectorFromSet(s.Spec.Selector)
			var keys []string
			for key, lbls := range podLabels {
				if len(lbls) == 0 {
					continue
				}
				// Only match pods in the same namespace as the service.
				if key[:len(s.Namespace)+1] != s.Namespace+"/" {
					continue
				}
				if sel.Matches(labels.Set(lbls)) {
					keys = append(keys, key)
				}
			}
			topo.Services = append(topo.Services, TopoService{
				Name: s.Name, Namespace: s.Namespace, Type: string(s.Spec.Type), PodKeys: keys,
			})
		}
	}
	return topo, nil
}
