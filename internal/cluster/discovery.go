package cluster

import (
	"context"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// ResourceKind describes one kind of resource the cluster exposes — built-in
// (Pod, Deployment) or custom (a CRD). This is how KubeForge covers EVERY
// resource of a cluster, including the low-level and self-managed ones, without
// hard-coding a handler per type: it asks the cluster what exists.
type ResourceKind struct {
	Group      string   `json:"group"`      // "" for core, e.g. "apps", "cert-manager.io"
	Version    string   `json:"version"`    // "v1", "v1beta1"…
	Kind       string   `json:"kind"`       // "Pod", "Certificate"…
	Name       string   `json:"name"`       // plural resource name, "pods", "certificates"
	Namespaced bool     `json:"namespaced"` // namespaced vs cluster-scoped
	Custom     bool     `json:"custom"`     // true when it comes from a CRD (not a built-in API group)
	Verbs      []string `json:"verbs"`      // list/get/watch… (what we're allowed to do)
}

// GVR is the group-version-resource this kind maps to, for the dynamic client.
func (rk ResourceKind) GVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: rk.Group, Version: rk.Version, Resource: rk.Name}
}

// dyn holds the extra clients the discovery/dynamic access needs. Built lazily
// from the same rest.Config as the typed client.
type dyn struct {
	disc discovery.DiscoveryInterface
	dc   dynamic.Interface
}

// withDynamic builds the discovery + dynamic clients. Called by Connect so the
// Client can serve any resource type, not just the typed ones.
func withDynamic(restCfg *rest.Config) (*dyn, error) {
	disc, err := discovery.NewDiscoveryClientForConfig(restCfg)
	if err != nil {
		return nil, err
	}
	dc, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return nil, err
	}
	return &dyn{disc: disc, dc: dc}, nil
}

// APIResources lists every listable resource kind the cluster exposes, sorted
// built-ins first then custom (CRDs), each alphabetically. This is the catalog
// the UI uses to let you browse ANY resource, including the low-level ones on a
// self-managed cluster. A partial-discovery error (a broken aggregated API) is
// tolerated: we return what we could discover rather than failing entirely.
func (c *Client) ResourceKinds(ctx context.Context) ([]ResourceKind, error) {
	if c.dyn == nil {
		return nil, nil
	}
	lists, err := c.dyn.disc.ServerPreferredResources()
	// ServerPreferredResources returns partial results + an aggregation error
	// when one API group is unhealthy; keep the partial results.
	if err != nil && len(lists) == 0 {
		return nil, err
	}

	var out []ResourceKind
	for _, list := range lists {
		gv, perr := schema.ParseGroupVersion(list.GroupVersion)
		if perr != nil {
			continue
		}
		for _, r := range list.APIResources {
			// Skip subresources (pods/status, etc.) and anything we can't list.
			if strings.Contains(r.Name, "/") || !canList(r.Verbs) {
				continue
			}
			out = append(out, ResourceKind{
				Group:      gv.Group,
				Version:    gv.Version,
				Kind:       r.Kind,
				Name:       r.Name,
				Namespaced: r.Namespaced,
				Custom:     isCustomGroup(gv.Group),
				Verbs:      r.Verbs,
			})
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Custom != out[b].Custom {
			return !out[a].Custom // built-ins first
		}
		if out[a].Group != out[b].Group {
			return out[a].Group < out[b].Group
		}
		return out[a].Kind < out[b].Kind
	})
	return out, nil
}

// ListResource lists objects of an arbitrary kind via the dynamic client,
// returning a compact, generic row per object (name, namespace, age) plus the
// raw object for a detail view. This is what powers "browse any resource".
func (c *Client) ListResource(ctx context.Context, rk ResourceKind, ns string) ([]GenericObject, error) {
	if c.dyn == nil {
		return nil, nil
	}
	ri := c.dyn.dc.Resource(rk.GVR())
	var listNS = ns
	if !rk.Namespaced {
		listNS = "" // cluster-scoped
	}
	list, err := ri.Namespace(listNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]GenericObject, 0, len(list.Items))
	for i := range list.Items {
		it := &list.Items[i]
		out = append(out, GenericObject{
			Name:      it.GetName(),
			Namespace: it.GetNamespace(),
			Age:       age(it.GetCreationTimestamp().Time),
		})
	}
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Namespace != out[b].Namespace {
			return out[a].Namespace < out[b].Namespace
		}
		return out[a].Name < out[b].Name
	})
	return out, nil
}

// GenericObject is the type-agnostic row for the resource browser.
type GenericObject struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Age       string `json:"age"`
}

// IsNamespaced reports whether a kind is namespaced, looked up from discovery.
// Defaults to true (the common case) when the kind can't be resolved.
func (c *Client) IsNamespaced(ctx context.Context, rk ResourceKind) bool {
	kinds, err := c.ResourceKinds(ctx)
	if err != nil {
		return true
	}
	for _, k := range kinds {
		if k.Group == rk.Group && k.Version == rk.Version && k.Name == rk.Name {
			return k.Namespaced
		}
	}
	return true
}

func canList(verbs []string) bool {
	for _, v := range verbs {
		if v == "list" {
			return true
		}
	}
	return false
}

// isCustomGroup treats the well-known built-in API groups as core, and
// everything else (which is where CRDs live) as custom.
func isCustomGroup(group string) bool {
	if group == "" {
		return false
	}
	builtins := map[string]bool{
		"apps": true, "batch": true, "networking.k8s.io": true, "rbac.authorization.k8s.io": true,
		"storage.k8s.io": true, "policy": true, "autoscaling": true, "apiextensions.k8s.io": true,
		"admissionregistration.k8s.io": true, "coordination.k8s.io": true, "scheduling.k8s.io": true,
		"node.k8s.io": true, "certificates.k8s.io": true, "discovery.k8s.io": true,
		"authentication.k8s.io": true, "authorization.k8s.io": true, "events.k8s.io": true,
		"flowcontrol.apiserver.k8s.io": true, "apiregistration.k8s.io": true,
	}
	return !builtins[group]
}
