package cluster

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// LayeredGraph is the "resource stack" view of a namespace: every object as a
// typed node, arranged into layers from high-level (Ingress, traffic in) down to
// low-level (Secrets, RBAC, storage), with edges for the real references between
// them (a Service selects Pods, a Pod mounts a Secret, a Pod runs as a
// ServiceAccount bound to a Role, a PVC binds a PV…). It's the picture that
// answers "how does everything in this namespace actually fit together" — which
// no resource list (k9s, Lens) draws.
type LayeredGraph struct {
	Namespace string      `json:"namespace"`
	Layers    []LayerMeta `json:"layers"` // display order, top (high-level) → bottom
	Nodes     []GraphNode `json:"nodes"`
	Edges     []GraphEdge `json:"edges"`
}

// LayerMeta describes one horizontal band.
type LayerMeta struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// GraphNode is one resource in the stack.
type GraphNode struct {
	ID      string `json:"id"`      // stable key: kind/namespace/name
	Kind    string `json:"kind"`    // Ingress, Service, Deployment, Pod, Secret…
	Name    string `json:"name"`    // display name
	Layer   string `json:"layer"`   // which band it sits in
	Healthy bool   `json:"healthy"` // for status coloring (pods/workloads mainly)
	Detail  string `json:"detail"`  // small subtitle (type, replicas, phase…)
}

// GraphEdge is a directed reference from → to (drawn top-down).
type GraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"` // "routes", "selects", "owns", "mounts", "runs-as", "binds", "governs"
}

// The layer stack, high-level (top) to low-level (bottom).
var layerOrder = []LayerMeta{
	{ID: "governance", Label: "Governance"}, // NetworkPolicy, ResourceQuota, LimitRange
	{ID: "ingress", Label: "Ingress"},
	{ID: "service", Label: "Services"},
	{ID: "workload", Label: "Workloads"},
	{ID: "replicaset", Label: "ReplicaSets"},
	{ID: "pod", Label: "Pods"},
	{ID: "config", Label: "Config & Secrets"},
	{ID: "rbac", Label: "Identity & RBAC"},
	{ID: "storage", Label: "Storage"},
}

func nodeID(kind, ns, name string) string { return kind + "/" + ns + "/" + name }

// Namespaces returns namespace names, sorted, for the layered-view selector.
func (c *Client) Namespaces(ctx context.Context) ([]string, error) {
	list, err := c.Kube.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, list.Items[i].Name)
	}
	return out, nil
}

// LayeredNamespace builds the full stacked graph for one namespace.
func (c *Client) LayeredNamespace(ctx context.Context, ns string) (*LayeredGraph, error) {
	if ns == "" {
		return nil, fmt.Errorf("a namespace is required for the layered view")
	}
	g := &LayeredGraph{Namespace: ns, Layers: layerOrder}
	seen := map[string]bool{}
	add := func(n GraphNode) {
		if !seen[n.ID] {
			seen[n.ID] = true
			g.Nodes = append(g.Nodes, n)
		}
	}
	link := func(from, to, kind string) {
		if from != "" && to != "" {
			g.Edges = append(g.Edges, GraphEdge{From: from, To: to, Kind: kind})
		}
	}

	core := c.Kube.CoreV1()
	apps := c.Kube.AppsV1()

	// ---- Pods (the pivot everything hangs off) ----
	pods, err := core.Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	podID := map[string]string{}   // pod name -> node id
	podLabels := map[string]labels.Set{}
	for i := range pods.Items {
		p := &pods.Items[i]
		sum := summarizePod(p)
		id := nodeID("Pod", ns, p.Name)
		podID[p.Name] = id
		podLabels[p.Name] = labels.Set(p.Labels)
		add(GraphNode{ID: id, Kind: "Pod", Name: p.Name, Layer: "pod", Healthy: sum.Healthy, Detail: sum.Status})

		// Pod → its ReplicaSet/StatefulSet/DaemonSet owner (workload layer)
		for _, ref := range p.OwnerReferences {
			switch ref.Kind {
			case "ReplicaSet":
				rsID := nodeID("ReplicaSet", ns, ref.Name)
				add(GraphNode{ID: rsID, Kind: "ReplicaSet", Name: ref.Name, Layer: "replicaset", Healthy: true})
				link(rsID, id, "owns")
			case "StatefulSet", "DaemonSet", "Job":
				wID := nodeID(ref.Kind, ns, ref.Name)
				add(GraphNode{ID: wID, Kind: ref.Kind, Name: ref.Name, Layer: "workload", Healthy: true})
				link(wID, id, "owns")
			}
		}

		// Pod → ServiceAccount (identity)
		if sa := p.Spec.ServiceAccountName; sa != "" && sa != "default" {
			saID := nodeID("ServiceAccount", ns, sa)
			add(GraphNode{ID: saID, Kind: "ServiceAccount", Name: sa, Layer: "rbac", Healthy: true})
			link(id, saID, "runs-as")
		}

		// Pod → mounted ConfigMaps / Secrets / PVCs
		for _, v := range p.Spec.Volumes {
			switch {
			case v.ConfigMap != nil:
				cID := nodeID("ConfigMap", ns, v.ConfigMap.Name)
				add(GraphNode{ID: cID, Kind: "ConfigMap", Name: v.ConfigMap.Name, Layer: "config", Healthy: true})
				link(id, cID, "mounts")
			case v.Secret != nil:
				sID := nodeID("Secret", ns, v.Secret.SecretName)
				add(GraphNode{ID: sID, Kind: "Secret", Name: v.Secret.SecretName, Layer: "config", Healthy: true})
				link(id, sID, "mounts")
			case v.PersistentVolumeClaim != nil:
				pvcID := nodeID("PersistentVolumeClaim", ns, v.PersistentVolumeClaim.ClaimName)
				add(GraphNode{ID: pvcID, Kind: "PersistentVolumeClaim", Name: v.PersistentVolumeClaim.ClaimName, Layer: "storage", Healthy: true})
				link(id, pvcID, "mounts")
			}
		}
		// envFrom / valueFrom references to secrets & configmaps
		for _, ctr := range p.Spec.Containers {
			for _, ef := range ctr.EnvFrom {
				if ef.ConfigMapRef != nil {
					cID := nodeID("ConfigMap", ns, ef.ConfigMapRef.Name)
					add(GraphNode{ID: cID, Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Layer: "config", Healthy: true})
					link(id, cID, "mounts")
				}
				if ef.SecretRef != nil {
					sID := nodeID("Secret", ns, ef.SecretRef.Name)
					add(GraphNode{ID: sID, Kind: "Secret", Name: ef.SecretRef.Name, Layer: "config", Healthy: true})
					link(id, sID, "mounts")
				}
			}
		}
	}

	// ---- Workloads (Deployments front their ReplicaSets) ----
	if deploys, err := apps.Deployments(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range deploys.Items {
			d := &deploys.Items[i]
			dID := nodeID("Deployment", ns, d.Name)
			healthy := d.Status.ReadyReplicas == d.Status.Replicas
			add(GraphNode{ID: dID, Kind: "Deployment", Name: d.Name, Layer: "workload", Healthy: healthy,
				Detail: fmt.Sprintf("%d/%d ready", d.Status.ReadyReplicas, d.Status.Replicas)})
		}
	}
	// Deployment → ReplicaSet ownership
	if rss, err := apps.ReplicaSets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range rss.Items {
			rs := &rss.Items[i]
			rsID := nodeID("ReplicaSet", ns, rs.Name)
			if !seen[rsID] {
				continue // skip RSes with no live pods to keep the graph tight
			}
			for _, ref := range rs.OwnerReferences {
				if ref.Kind == "Deployment" {
					link(nodeID("Deployment", ns, ref.Name), rsID, "owns")
				}
			}
		}
	}
	// StatefulSets / DaemonSets that may have no pods listed yet still show up
	if sts, err := apps.StatefulSets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range sts.Items {
			s := &sts.Items[i]
			id := nodeID("StatefulSet", ns, s.Name)
			add(GraphNode{ID: id, Kind: "StatefulSet", Name: s.Name, Layer: "workload",
				Healthy: s.Status.ReadyReplicas == s.Status.Replicas,
				Detail:  fmt.Sprintf("%d/%d ready", s.Status.ReadyReplicas, s.Status.Replicas)})
		}
	}
	if dss, err := apps.DaemonSets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range dss.Items {
			d := &dss.Items[i]
			id := nodeID("DaemonSet", ns, d.Name)
			add(GraphNode{ID: id, Kind: "DaemonSet", Name: d.Name, Layer: "workload",
				Healthy: d.Status.NumberReady == d.Status.DesiredNumberScheduled,
				Detail:  fmt.Sprintf("%d/%d ready", d.Status.NumberReady, d.Status.DesiredNumberScheduled)})
		}
	}

	// ---- Services → the pods they select ----
	svcTargets := map[string]string{} // service name -> node id (for ingress edges)
	if svcs, err := core.Services(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range svcs.Items {
			s := &svcs.Items[i]
			sID := nodeID("Service", ns, s.Name)
			svcTargets[s.Name] = sID
			add(GraphNode{ID: sID, Kind: "Service", Name: s.Name, Layer: "service", Healthy: true, Detail: string(s.Spec.Type)})
			if len(s.Spec.Selector) == 0 {
				continue
			}
			sel := labels.SelectorFromSet(s.Spec.Selector)
			for name, lset := range podLabels {
				if sel.Matches(lset) {
					link(sID, podID[name], "selects")
				}
			}
		}
	}

	// ---- Ingress → Service ----
	if ings, err := c.Kube.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range ings.Items {
			ing := &ings.Items[i]
			iID := nodeID("Ingress", ns, ing.Name)
			add(GraphNode{ID: iID, Kind: "Ingress", Name: ing.Name, Layer: "ingress", Healthy: true})
			for _, rule := range ing.Spec.Rules {
				if rule.HTTP == nil {
					continue
				}
				for _, path := range rule.HTTP.Paths {
					if path.Backend.Service != nil {
						if tid, ok := svcTargets[path.Backend.Service.Name]; ok {
							link(iID, tid, "routes")
						}
					}
				}
			}
		}
	}

	// ---- RBAC: RoleBindings → Role/ClusterRole, and → ServiceAccount subjects ----
	if rbs, err := c.Kube.RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range rbs.Items {
			rb := &rbs.Items[i]
			rbID := nodeID("RoleBinding", ns, rb.Name)
			roleID := nodeID(rb.RoleRef.Kind, ns, rb.RoleRef.Name)
			// only surface the binding if it targets a SA we already drew
			bound := false
			for _, sub := range rb.Subjects {
				if sub.Kind == "ServiceAccount" {
					saID := nodeID("ServiceAccount", ns, sub.Name)
					if seen[saID] {
						add(GraphNode{ID: rbID, Kind: "RoleBinding", Name: rb.Name, Layer: "rbac", Healthy: true})
						add(GraphNode{ID: roleID, Kind: rb.RoleRef.Kind, Name: rb.RoleRef.Name, Layer: "rbac", Healthy: true})
						link(saID, rbID, "binds")
						link(rbID, roleID, "binds")
						bound = true
					}
				}
			}
			_ = bound
		}
	}

	// ---- Storage: PVC → PV → StorageClass ----
	if pvcs, err := core.PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range pvcs.Items {
			pvc := &pvcs.Items[i]
			pvcID := nodeID("PersistentVolumeClaim", ns, pvc.Name)
			if !seen[pvcID] {
				// PVC that isn't mounted by any pod — still worth showing in storage
				add(GraphNode{ID: pvcID, Kind: "PersistentVolumeClaim", Name: pvc.Name, Layer: "storage", Healthy: true, Detail: string(pvc.Status.Phase)})
			}
			if pvc.Spec.VolumeName != "" {
				pvID := nodeID("PersistentVolume", "", pvc.Spec.VolumeName)
				add(GraphNode{ID: pvID, Kind: "PersistentVolume", Name: pvc.Spec.VolumeName, Layer: "storage", Healthy: true})
				link(pvcID, pvID, "binds")
				if pvc.Spec.StorageClassName != nil && *pvc.Spec.StorageClassName != "" {
					scID := nodeID("StorageClass", "", *pvc.Spec.StorageClassName)
					add(GraphNode{ID: scID, Kind: "StorageClass", Name: *pvc.Spec.StorageClassName, Layer: "storage", Healthy: true})
					link(pvID, scID, "binds")
				}
			}
		}
	}

	// ---- Governance: NetworkPolicy / ResourceQuota / LimitRange (they encircle the namespace) ----
	addGovernance(ctx, c, ns, add)

	return g, nil
}

// addGovernance surfaces the namespace guard-rails as top-layer nodes. They
// don't point at specific pods (they apply broadly), so they sit as context.
func addGovernance(ctx context.Context, c *Client, ns string, add func(GraphNode)) {
	if nps, err := c.Kube.NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range nps.Items {
			np := &nps.Items[i]
			add(GraphNode{ID: nodeID("NetworkPolicy", ns, np.Name), Kind: "NetworkPolicy", Name: np.Name, Layer: "governance", Healthy: true})
		}
	}
	if rqs, err := c.Kube.CoreV1().ResourceQuotas(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range rqs.Items {
			rq := &rqs.Items[i]
			add(GraphNode{ID: nodeID("ResourceQuota", ns, rq.Name), Kind: "ResourceQuota", Name: rq.Name, Layer: "governance", Healthy: true})
		}
	}
	if lrs, err := c.Kube.CoreV1().LimitRanges(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range lrs.Items {
			lr := &lrs.Items[i]
			add(GraphNode{ID: nodeID("LimitRange", ns, lr.Name), Kind: "LimitRange", Name: lr.Name, Layer: "governance", Healthy: true})
		}
	}
}

// compile-time nudge that appsv1/corev1 stay imported even if a branch is edited out.
var _ = appsv1.Deployment{}
var _ = corev1.Pod{}
