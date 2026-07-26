package cluster

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/yaml"
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
	// Info is a set of type-specific facts surfaced in the hover panel (IP,
	// node, ports, capacity, image, estimated monthly cost…). Order-preserving
	// so the UI can render label/value rows predictably.
	Info []KV `json:"info,omitempty"`
	// Risk holds inline SecOps warnings (privileged, hostNetwork…) so the UI can
	// flag a node without opening the SecOps tab. Empty = clean.
	Risk []string `json:"risk,omitempty"`
	// Custom marks CRD-backed nodes (ServiceMonitor, Certificate…) so the UI can
	// badge them as coming from an operator, not core Kubernetes.
	Custom bool `json:"custom,omitempty"`
}

// KV is one label/value fact shown in the detail panel.
type KV struct {
	K string `json:"k"`
	V string `json:"v"`
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
	// Initialize the slices so an empty namespace serializes as [] not null
	// (a null broke the frontend layout).
	g := &LayeredGraph{Namespace: ns, Layers: layerOrder, Nodes: []GraphNode{}, Edges: []GraphEdge{}}
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
	// Per-workload cost, summed across the workload's pods (resolved via owner).
	wlCost := map[string]float64{}
	for i := range pods.Items {
		p := &pods.Items[i]
		sum := summarizePod(p)
		id := nodeID("Pod", ns, p.Name)
		podID[p.Name] = id
		podLabels[p.Name] = labels.Set(p.Labels)
		add(GraphNode{ID: id, Kind: "Pod", Name: p.Name, Layer: "pod", Healthy: sum.Healthy, Detail: sum.Status, Info: podInfo(p), Risk: podRisk(p)})

		// accumulate this pod's cost onto its top workload (Deployment via RS)
		cpu, mem := podRequests(p)
		ownerName, ownerKind := workloadOf(p)
		wlCost[ownerKind+"/"+ownerName] += monthlyCost(cpu, mem)

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
				Detail: fmt.Sprintf("%d/%d ready", d.Status.ReadyReplicas, d.Status.Replicas),
				Info:   workloadInfo(d.Spec.Template.Spec, d.CreationTimestamp.Time, wlCost["Deployment/"+d.Name])})
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
				Detail:  fmt.Sprintf("%d/%d ready", s.Status.ReadyReplicas, s.Status.Replicas),
				Info:    workloadInfo(s.Spec.Template.Spec, s.CreationTimestamp.Time, wlCost["StatefulSet/"+s.Name])})
		}
	}
	if dss, err := apps.DaemonSets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range dss.Items {
			d := &dss.Items[i]
			id := nodeID("DaemonSet", ns, d.Name)
			add(GraphNode{ID: id, Kind: "DaemonSet", Name: d.Name, Layer: "workload",
				Healthy: d.Status.NumberReady == d.Status.DesiredNumberScheduled,
				Detail:  fmt.Sprintf("%d/%d ready", d.Status.NumberReady, d.Status.DesiredNumberScheduled),
				Info:    workloadInfo(d.Spec.Template.Spec, d.CreationTimestamp.Time, wlCost["DaemonSet/"+d.Name])})
		}
	}

	// ---- CronJobs (own the Jobs already drawn) ----
	if cjs, err := c.Kube.BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range cjs.Items {
			cj := &cjs.Items[i]
			cjID := nodeID("CronJob", ns, cj.Name)
			add(GraphNode{ID: cjID, Kind: "CronJob", Name: cj.Name, Layer: "workload", Healthy: true,
				Detail: cj.Spec.Schedule, Info: []KV{{K: "Schedule", V: cj.Spec.Schedule}}})
			// link to any Job it owns that we've drawn
			for _, n := range g.Nodes {
				if n.Kind == "Job" && hasPrefix(n.Name, cj.Name+"-") {
					link(cjID, n.ID, "owns")
				}
			}
		}
	}

	// ---- HorizontalPodAutoscalers → their target workload ----
	if hpas, err := c.Kube.AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range hpas.Items {
			h := &hpas.Items[i]
			hID := nodeID("HorizontalPodAutoscaler", ns, h.Name)
			detail := fmt.Sprintf("%d–%d replicas", ptrInt32(h.Spec.MinReplicas, 1), h.Spec.MaxReplicas)
			add(GraphNode{ID: hID, Kind: "HorizontalPodAutoscaler", Name: h.Name, Layer: "governance", Healthy: true,
				Detail: detail, Info: []KV{
					{K: "Target", V: h.Spec.ScaleTargetRef.Kind + "/" + h.Spec.ScaleTargetRef.Name},
					{K: "Range", V: detail},
					{K: "Current", V: fmt.Sprintf("%d replicas", h.Status.CurrentReplicas)},
				}})
			tID := nodeID(h.Spec.ScaleTargetRef.Kind, ns, h.Spec.ScaleTargetRef.Name)
			if seen[tID] {
				link(hID, tID, "governs")
			}
		}
	}

	// ---- PodDisruptionBudgets (governance) ----
	if pdbs, err := c.Kube.PolicyV1().PodDisruptionBudgets(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range pdbs.Items {
			pdb := &pdbs.Items[i]
			add(GraphNode{ID: nodeID("PodDisruptionBudget", ns, pdb.Name), Kind: "PodDisruptionBudget",
				Name: pdb.Name, Layer: "governance", Healthy: true,
				Detail: fmt.Sprintf("%d healthy", pdb.Status.CurrentHealthy)})
		}
	}

	// ---- Services → the pods they select ----
	svcTargets := map[string]string{} // service name -> node id (for ingress edges)
	if svcs, err := core.Services(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range svcs.Items {
			s := &svcs.Items[i]
			sID := nodeID("Service", ns, s.Name)
			svcTargets[s.Name] = sID
			add(GraphNode{ID: sID, Kind: "Service", Name: s.Name, Layer: "service", Healthy: true, Detail: string(s.Spec.Type), Info: svcInfo(s)})
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
			// Always (re)describe with capacity + estimated storage cost.
			capGB := 0.0
			if q, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
				capGB = float64(q.Value()) / (1024 * 1024 * 1024)
			} else if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
				capGB = float64(q.Value()) / (1024 * 1024 * 1024)
			}
			pvcInfo := []KV{
				{K: "Phase", V: string(pvc.Status.Phase)},
				{K: "Capacity", V: fmt.Sprintf("%.0f Gi", capGB)},
				{K: "Est. cost", V: fmt.Sprintf("~$%.2f/mo", capGB*0.10)}, // ~$0.10/GB-mo block storage
			}
			if pvc.Spec.StorageClassName != nil {
				pvcInfo = append(pvcInfo, KV{K: "Class", V: *pvc.Spec.StorageClassName})
			}
			if !seen[pvcID] {
				add(GraphNode{ID: pvcID, Kind: "PersistentVolumeClaim", Name: pvc.Name, Layer: "storage", Healthy: true, Detail: string(pvc.Status.Phase), Info: pvcInfo})
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

	// ---- Custom resources (CRDs): ServiceMonitor, Certificate, and anything an
	// operator installed. Discovered dynamically so self-managed clusters with
	// their own CRDs are first-class. Best-effort: never fail the whole graph. ----
	c.addCustomResources(ctx, ns, add)

	return g, nil
}

// ObjectYAML fetches a single object's YAML by kind/namespace/name, for the
// "view manifest" action on a node. Uses discovery to map the kind to its GVR,
// then the dynamic client to read it. Secrets are returned with data redacted.
func (c *Client) ObjectYAML(ctx context.Context, kind, ns, name string) (string, error) {
	if c.dyn == nil {
		return "", fmt.Errorf("dynamic client unavailable")
	}
	kinds, err := c.ResourceKinds(ctx)
	if err != nil {
		return "", err
	}
	var rk *ResourceKind
	for i := range kinds {
		if kinds[i].Kind == kind {
			rk = &kinds[i]
			break
		}
	}
	if rk == nil {
		return "", fmt.Errorf("unknown kind %q", kind)
	}
	ri := c.dyn.dc.Resource(rk.GVR())
	var obj *unstructured.Unstructured
	if rk.Namespaced {
		obj, err = ri.Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		return "", err
	}
	// Never leak secret material through the manifest view.
	if kind == "Secret" {
		if _, ok := obj.Object["data"]; ok {
			obj.Object["data"] = "«redacted by KubeForge»"
		}
	}
	// strip noisy managed fields
	meta, _ := obj.Object["metadata"].(map[string]any)
	if meta != nil {
		delete(meta, "managedFields")
	}
	out, err := yaml.Marshal(obj.Object)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ObjectEvents returns recent events for an object, for the node's "events"
// action — the quick "why is this unhealthy" answer.
func (c *Client) ObjectEvents(ctx context.Context, ns, name string) ([]EventLine, error) {
	evs, err := c.Kube.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.name=" + name,
	})
	if err != nil {
		return nil, err
	}
	out := make([]EventLine, 0, len(evs.Items))
	for i := range evs.Items {
		e := &evs.Items[i]
		out = append(out, EventLine{
			Type: e.Type, Reason: e.Reason, Message: e.Message,
			Count: e.Count, Age: ageOrDash(e.LastTimestamp.Time),
		})
	}
	return out, nil
}

// EventLine is one event row for the node detail panel.
type EventLine struct {
	Type    string `json:"type"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
	Count   int32  `json:"count"`
	Age     string `json:"age"`
}

// addCustomResources lists CRD-backed objects in the namespace via the dynamic
// client and drops them into the workload layer, badged as custom. It skips core
// groups (already drawn) and anything that isn't namespaced or listable.
func (c *Client) addCustomResources(ctx context.Context, ns string, add func(GraphNode)) {
	if c.dyn == nil {
		return
	}
	kinds, err := c.ResourceKinds(ctx)
	if err != nil {
		return
	}
	for _, rk := range kinds {
		if !rk.Custom || !rk.Namespaced {
			continue
		}
		objs, err := c.ListResource(ctx, rk, ns)
		if err != nil {
			continue
		}
		for _, o := range objs {
			add(GraphNode{
				ID: nodeID(rk.Kind, ns, o.Name), Kind: rk.Kind, Name: o.Name,
				Layer: "workload", Healthy: true, Custom: true,
				Detail: rk.Kind,
				Info:   []KV{{K: "Kind", V: rk.Kind}, {K: "Group", V: rk.Group}, {K: "Age", V: o.Age}},
			})
		}
	}
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

// ---- detail-panel builders (the hover facts) ------------------------------

// stackPrices mirrors finops defaults; kept local so layers doesn't depend on
// the finops package. Rough on-demand-ish averages — for ranking, not billing.
const (
	priceCPUHour = 0.031
	priceGBHour  = 0.004
	hoursMonth   = 730.0
)

func monthlyCost(cpuCores, memGB float64) float64 {
	return (cpuCores*priceCPUHour + memGB*priceGBHour) * hoursMonth
}

// podInfo builds the hover facts for a pod: IP, node, restarts, requests, and an
// estimated monthly cost of what it reserves.
func podInfo(p *corev1.Pod) []KV {
	var restarts int32
	for _, cs := range p.Status.ContainerStatuses {
		restarts += cs.RestartCount
	}
	cpu, mem := podRequests(p)
	info := []KV{
		{K: "Pod IP", V: orDash(p.Status.PodIP)},
		{K: "Node", V: orDash(p.Spec.NodeName)},
		{K: "Phase", V: string(p.Status.Phase)},
		{K: "Restarts", V: fmt.Sprintf("%d", restarts)},
	}
	if len(p.Spec.Containers) > 0 {
		info = append(info, KV{K: "Image", V: shortImage(p.Spec.Containers[0].Image)})
	}
	if cpu > 0 || mem > 0 {
		info = append(info,
			KV{K: "Requests", V: fmt.Sprintf("%.0fm CPU · %.0fMi", cpu*1000, mem*1024)},
			KV{K: "Est. cost", V: fmt.Sprintf("~$%.2f/mo", monthlyCost(cpu, mem))},
		)
	}
	info = append(info, KV{K: "Age", V: ageOrDash(p.CreationTimestamp.Time)})
	if lbl := topLabels(p.Labels); lbl != "" {
		info = append(info, KV{K: "Labels", V: lbl})
	}
	return info
}

// podRisk runs a few cheap, high-signal SecOps checks so a risky pod can be
// flagged inline. Mirrors the SecOps scanner's headline findings.
func podRisk(p *corev1.Pod) []string {
	var out []string
	if p.Spec.HostNetwork {
		out = append(out, "hostNetwork")
	}
	if p.Spec.HostPID {
		out = append(out, "hostPID")
	}
	for _, c := range p.Spec.Containers {
		sc := c.SecurityContext
		if sc == nil {
			continue
		}
		if sc.Privileged != nil && *sc.Privileged {
			out = append(out, "privileged")
		}
		if sc.AllowPrivilegeEscalation != nil && *sc.AllowPrivilegeEscalation {
			out = append(out, "allowPrivilegeEscalation")
		}
		if sc.Capabilities != nil {
			for _, ca := range sc.Capabilities.Add {
				if ca == "SYS_ADMIN" || ca == "NET_ADMIN" || ca == "ALL" {
					out = append(out, "cap:"+string(ca))
				}
			}
		}
	}
	return dedup(out)
}

// ageOrDash is age() with a dash fallback for zero times (age() returns "").
func ageOrDash(t time.Time) string {
	if s := age(t); s != "" {
		return s
	}
	return "—"
}

// topLabels renders up to three of the most useful labels (app/component/tier).
func topLabels(m map[string]string) string {
	prefer := []string{"app", "app.kubernetes.io/name", "component", "tier", "release"}
	var parts []string
	for _, k := range prefer {
		if v, ok := m[k]; ok {
			parts = append(parts, v)
			if len(parts) == 2 {
				break
			}
		}
	}
	return joinComma(parts)
}

func dedup(ss []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// podRequests sums CPU (cores) and memory (GB) requested across containers.
func podRequests(p *corev1.Pod) (cpu, memGB float64) {
	for _, c := range p.Spec.Containers {
		if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpu += float64(q.MilliValue()) / 1000
		}
		if q, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memGB += float64(q.Value()) / (1024 * 1024 * 1024)
		}
	}
	return cpu, memGB
}

// workloadInfo builds hover facts for a workload: image, age, and the aggregate
// monthly cost of all its replicas (the number that actually matters for FinOps).
func workloadInfo(spec corev1.PodSpec, created time.Time, cost float64) []KV {
	info := []KV{}
	if len(spec.Containers) > 0 {
		info = append(info, KV{K: "Image", V: shortImage(spec.Containers[0].Image)})
	}
	if cost > 0 {
		info = append(info, KV{K: "Cost (all pods)", V: fmt.Sprintf("~$%.2f/mo", cost)})
	}
	info = append(info, KV{K: "Age", V: ageOrDash(created)})
	return info
}

func svcInfo(s *corev1.Service) []KV {
	ports := make([]string, 0, len(s.Spec.Ports))
	for _, p := range s.Spec.Ports {
		ports = append(ports, fmt.Sprintf("%d/%s", p.Port, p.Protocol))
	}
	info := []KV{
		{K: "Type", V: string(s.Spec.Type)},
		{K: "ClusterIP", V: orDash(s.Spec.ClusterIP)},
		{K: "Ports", V: orDash(joinComma(ports))},
	}
	if len(s.Status.LoadBalancer.Ingress) > 0 {
		ext := s.Status.LoadBalancer.Ingress[0].IP
		if ext == "" {
			ext = s.Status.LoadBalancer.Ingress[0].Hostname
		}
		info = append(info, KV{K: "External", V: orDash(ext)})
	}
	return info
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func joinComma(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}

func shortImage(img string) string {
	// drop the registry host, keep repo:tag
	if i := lastSlash(img); i >= 0 {
		img = img[i+1:]
	}
	if len(img) > 28 {
		img = img[:28] + "…"
	}
	return img
}

func lastSlash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func ptrInt32(p *int32, def int32) int32 {
	if p == nil {
		return def
	}
	return *p
}

// compile-time nudge that appsv1/corev1 stay imported even if a branch is edited out.
var _ = appsv1.Deployment{}
var _ = corev1.Pod{}
