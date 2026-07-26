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

// TopoPod is a pod in the graph, with enough to color it by health.
type TopoPod struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Healthy   bool   `json:"healthy"`
	Status    string `json:"status"`
}

// TopoService is a service and the pod keys (namespace/name) it selects, so the
// UI can draw service→pod edges.
type TopoService struct {
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Type      string   `json:"type"`
	PodKeys   []string `json:"podKeys"`
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
		tp := TopoPod{Name: p.Name, Namespace: p.Namespace, Healthy: sum.Healthy, Status: sum.Status}
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
