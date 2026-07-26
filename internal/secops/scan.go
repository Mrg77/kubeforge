package secops

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Scan runs the full posture scan against a cluster. It is read-only and
// deterministic. A failure to read one resource type degrades that check
// rather than failing the whole scan.
func Scan(ctx context.Context, kube kubernetes.Interface) (*Report, error) {
	rep := &Report{Findings: []Finding{}}

	// --- Pod security + images -------------------------------------------
	pods, err := kube.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err == nil {
		rep.Scanned.Pods = len(pods.Items)
		for i := range pods.Items {
			rep.Findings = append(rep.Findings, checkPod(&pods.Items[i])...)
		}
	}

	// --- Network: namespaces without any NetworkPolicy -------------------
	if nsList, err := kube.CoreV1().Namespaces().List(ctx, metav1.ListOptions{}); err == nil {
		rep.Scanned.Namespaces = len(nsList.Items)
		rep.Findings = append(rep.Findings, checkNetworkPolicies(ctx, kube, nsList.Items)...)
	}

	// --- RBAC: over-broad cluster-admin bindings -------------------------
	if crbs, err := kube.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{}); err == nil {
		rep.Scanned.ClusterRoleBind = len(crbs.Items)
		rep.Findings = append(rep.Findings, checkClusterAdmin(crbs.Items)...)
	}

	sortFindings(rep.Findings)
	rep.tally()
	return rep, nil
}

// checkPod flags lax pod security settings and mutable images. These are the
// classic "makes exploitation trivial" misconfigurations.
func checkPod(p *corev1.Pod) []Finding {
	var out []Finding
	obj := fmt.Sprintf("%s/%s (Pod)", p.Namespace, p.Name)

	// hostNetwork / hostPID / hostIPC: the pod shares the node's namespaces.
	if p.Spec.HostNetwork {
		out = append(out, mk(CatPodSecurity, SevHigh, "runs with hostNetwork", obj, p.Namespace,
			"The pod shares the node's network stack, so it can reach anything the node can and bypass NetworkPolicies. Remove hostNetwork unless the workload truly needs it."))
	}
	if p.Spec.HostPID {
		out = append(out, mk(CatPodSecurity, SevHigh, "runs with hostPID", obj, p.Namespace,
			"The pod can see and signal every process on the node. Remove hostPID."))
	}

	for _, c := range p.Spec.Containers {
		cobj := obj + " · " + c.Name
		sc := c.SecurityContext

		if sc != nil && sc.Privileged != nil && *sc.Privileged {
			out = append(out, mk(CatPodSecurity, SevCritical, "privileged container", cobj, p.Namespace,
				"A privileged container has near-root access to the node — a container escape becomes a node compromise. Drop privileged:true; grant only the specific capabilities you need."))
		}
		if runsAsRoot(sc, p.Spec.SecurityContext) {
			out = append(out, mk(CatPodSecurity, SevMedium, "may run as root", cobj, p.Namespace,
				"No runAsNonRoot / runAsUser is set, so the container can run as UID 0. Set securityContext.runAsNonRoot: true (and a runAsUser)."))
		}
		if sc != nil && sc.AllowPrivilegeEscalation != nil && *sc.AllowPrivilegeEscalation {
			out = append(out, mk(CatPodSecurity, SevLow, "allows privilege escalation", cobj, p.Namespace,
				"allowPrivilegeEscalation lets a process gain more privileges than its parent. Set it to false."))
		}
		if addsDangerousCaps(sc) {
			out = append(out, mk(CatPodSecurity, SevHigh, "adds dangerous Linux capabilities", cobj, p.Namespace,
				"Capabilities like SYS_ADMIN/NET_ADMIN grant node-level power. Drop ALL capabilities and add back only what's required."))
		}

		// Image hygiene: mutable tags mean the running code can change under you.
		if img := c.Image; usesMutableTag(img) {
			out = append(out, mk(CatImages, SevLow, "image uses a mutable tag", cobj, p.Namespace,
				fmt.Sprintf("%q has no immutable digest (@sha256:…) and/or uses :latest, so the code can change without a redeploy. Pin the image by digest.", img)))
		}
	}
	return out
}

// checkNetworkPolicies flags any namespace that has zero NetworkPolicies —
// meaning all pods there accept traffic from anywhere by default.
func checkNetworkPolicies(ctx context.Context, kube kubernetes.Interface, namespaces []corev1.Namespace) []Finding {
	var out []Finding
	for i := range namespaces {
		ns := namespaces[i].Name
		if isSystemNS(ns) {
			continue // system namespaces are noisy and expected to be open
		}
		nps, err := kube.NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		if len(nps.Items) == 0 {
			out = append(out, mk(CatNetwork, SevMedium, "namespace has no NetworkPolicy", ns+" (Namespace)", ns,
				"With no NetworkPolicy, every pod in this namespace accepts traffic from anywhere in the cluster. Add a default-deny policy and open only what's needed."))
		}
	}
	return out
}

// checkClusterAdmin flags bindings that grant cluster-admin (or a wildcard
// role) to non-system subjects — the broadest RBAC grant there is.
func checkClusterAdmin(crbs []rbacv1.ClusterRoleBinding) []Finding {
	var out []Finding
	for i := range crbs {
		crb := &crbs[i]
		if crb.RoleRef.Kind != "ClusterRole" || crb.RoleRef.Name != "cluster-admin" {
			continue
		}
		for _, sub := range crb.Subjects {
			// The built-in system:masters binding is expected; flag others.
			if sub.Name == "system:masters" || strings.HasPrefix(sub.Name, "system:") {
				continue
			}
			out = append(out, mk(CatRBAC, SevHigh, "cluster-admin granted to a subject", crb.Name+" (ClusterRoleBinding)", "",
				fmt.Sprintf("%s %q holds cluster-admin — full control of the cluster. Scope it down to a Role/ClusterRole with only the verbs and resources it needs.", sub.Kind, sub.Name)))
		}
	}
	return out
}

// --- helpers -----------------------------------------------------------------

func runsAsRoot(sc *corev1.SecurityContext, pod *corev1.PodSecurityContext) bool {
	// Non-root is explicitly established by either the container or pod context.
	if sc != nil {
		if sc.RunAsNonRoot != nil && *sc.RunAsNonRoot {
			return false
		}
		if sc.RunAsUser != nil && *sc.RunAsUser != 0 {
			return false
		}
	}
	if pod != nil {
		if pod.RunAsNonRoot != nil && *pod.RunAsNonRoot {
			return false
		}
		if pod.RunAsUser != nil && *pod.RunAsUser != 0 {
			return false
		}
	}
	return true // nothing forbids root
}

func addsDangerousCaps(sc *corev1.SecurityContext) bool {
	if sc == nil || sc.Capabilities == nil {
		return false
	}
	dangerous := map[corev1.Capability]bool{
		"SYS_ADMIN": true, "NET_ADMIN": true, "SYS_PTRACE": true,
		"SYS_MODULE": true, "ALL": true,
	}
	for _, c := range sc.Capabilities.Add {
		if dangerous[c] {
			return true
		}
	}
	return false
}

func usesMutableTag(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return false // pinned by digest
	}
	if strings.HasSuffix(image, ":latest") || !strings.Contains(image, ":") {
		return true // :latest or no tag at all
	}
	return false
}

func isSystemNS(ns string) bool {
	switch ns {
	case "kube-system", "kube-public", "kube-node-lease", "local-path-storage":
		return true
	}
	return false
}

func sortFindings(fs []Finding) {
	sort.SliceStable(fs, func(a, b int) bool {
		if fs[a].Severity != fs[b].Severity {
			return fs[a].Severity > fs[b].Severity
		}
		if fs[a].Category != fs[b].Category {
			return fs[a].Category < fs[b].Category
		}
		return fs[a].Object < fs[b].Object
	})
}
