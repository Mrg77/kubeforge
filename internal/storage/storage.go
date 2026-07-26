// Package storage is KubeForge's storage view: PersistentVolumes, Claims and
// StorageClasses, plus the waste that hides in them — released/unbound volumes
// still costing money, and PVCs nothing mounts. Storage is the pillar most
// dashboards neglect, yet orphaned disks are a classic silent cost.
package storage

import (
	"context"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Volume is the UI view of a PersistentVolume.
type Volume struct {
	Name          string  `json:"name"`
	CapacityGB    float64 `json:"capacityGB"`
	Phase         string  `json:"phase"` // Bound, Available, Released, Failed
	StorageClass  string  `json:"storageClass"`
	Claim         string  `json:"claim,omitempty"` // namespace/name of the bound PVC
	ReclaimPolicy string  `json:"reclaimPolicy"`
	Orphaned      bool    `json:"orphaned"` // Released/Available: capacity paid for, nobody using it
	Age           string  `json:"age"`
}

// Claim is the UI view of a PersistentVolumeClaim.
type Claim struct {
	Name         string  `json:"name"`
	Namespace    string  `json:"namespace"`
	Phase        string  `json:"phase"` // Bound, Pending, Lost
	CapacityGB   float64 `json:"capacityGB"`
	StorageClass string  `json:"storageClass"`
	Volume       string  `json:"volume,omitempty"`
	Unmounted    bool    `json:"unmounted"` // Bound but no pod mounts it
	Age          string  `json:"age"`
}

// Class is the UI view of a StorageClass.
type Class struct {
	Name          string `json:"name"`
	Provisioner   string `json:"provisioner"`
	Default       bool   `json:"default"`
	ReclaimPolicy string `json:"reclaimPolicy"`
	Age           string `json:"age"`
}

// Report is the whole storage picture.
type Report struct {
	Volumes []Volume `json:"volumes"`
	Claims  []Claim  `json:"claims"`
	Classes []Class  `json:"classes"`

	TotalCapacityGB    float64 `json:"totalCapacityGB"`
	OrphanedCapacityGB float64 `json:"orphanedCapacityGB"` // released/available capacity nobody uses
	UnmountedClaims    int     `json:"unmountedClaims"`
}

// Scan reads the cluster's storage objects and computes the waste signals.
func Scan(ctx context.Context, kube kubernetes.Interface) (*Report, error) {
	rep := &Report{Volumes: []Volume{}, Claims: []Claim{}, Classes: []Class{}}

	// Which PVCs are actually mounted by a pod? (so we can flag the ones that aren't)
	mounted := map[string]bool{}
	if pods, err := kube.CoreV1().Pods("").List(ctx, metav1.ListOptions{}); err == nil {
		for i := range pods.Items {
			p := &pods.Items[i]
			for _, v := range p.Spec.Volumes {
				if v.PersistentVolumeClaim != nil {
					mounted[p.Namespace+"/"+v.PersistentVolumeClaim.ClaimName] = true
				}
			}
		}
	}

	// StorageClasses (+ which is default).
	if scs, err := kube.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{}); err == nil {
		for i := range scs.Items {
			sc := &scs.Items[i]
			policy := ""
			if sc.ReclaimPolicy != nil {
				policy = string(*sc.ReclaimPolicy)
			}
			rep.Classes = append(rep.Classes, Class{
				Name:          sc.Name,
				Provisioner:   sc.Provisioner,
				Default:       sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true",
				ReclaimPolicy: policy,
				Age:           age(sc.CreationTimestamp.Time),
			})
		}
	}

	// PersistentVolumes.
	if pvs, err := kube.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{}); err == nil {
		for i := range pvs.Items {
			pv := &pvs.Items[i]
			cap := gib(pv.Spec.Capacity.Storage())
			rep.TotalCapacityGB += cap
			claim := ""
			if pv.Spec.ClaimRef != nil {
				claim = pv.Spec.ClaimRef.Namespace + "/" + pv.Spec.ClaimRef.Name
			}
			// Released/Available = capacity reserved but not serving a workload.
			orphaned := pv.Status.Phase == corev1.VolumeReleased || pv.Status.Phase == corev1.VolumeAvailable
			if orphaned {
				rep.OrphanedCapacityGB += cap
			}
			rep.Volumes = append(rep.Volumes, Volume{
				Name:          pv.Name,
				CapacityGB:    round(cap),
				Phase:         string(pv.Status.Phase),
				StorageClass:  pv.Spec.StorageClassName,
				Claim:         claim,
				ReclaimPolicy: string(pv.Spec.PersistentVolumeReclaimPolicy),
				Orphaned:      orphaned,
				Age:           age(pv.CreationTimestamp.Time),
			})
		}
	}

	// PersistentVolumeClaims.
	if pvcs, err := kube.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{}); err == nil {
		for i := range pvcs.Items {
			pvc := &pvcs.Items[i]
			cap := gib(pvc.Status.Capacity.Storage())
			sc := ""
			if pvc.Spec.StorageClassName != nil {
				sc = *pvc.Spec.StorageClassName
			}
			unmounted := pvc.Status.Phase == corev1.ClaimBound && !mounted[pvc.Namespace+"/"+pvc.Name]
			if unmounted {
				rep.UnmountedClaims++
			}
			rep.Claims = append(rep.Claims, Claim{
				Name:         pvc.Name,
				Namespace:    pvc.Namespace,
				Phase:        string(pvc.Status.Phase),
				CapacityGB:   round(cap),
				StorageClass: sc,
				Volume:       pvc.Spec.VolumeName,
				Unmounted:    unmounted,
				Age:          age(pvc.CreationTimestamp.Time),
			})
		}
	}

	// Orphaned/problem items first.
	sort.SliceStable(rep.Volumes, func(a, b int) bool {
		if rep.Volumes[a].Orphaned != rep.Volumes[b].Orphaned {
			return rep.Volumes[a].Orphaned
		}
		return rep.Volumes[a].Name < rep.Volumes[b].Name
	})
	sort.SliceStable(rep.Claims, func(a, b int) bool {
		if rep.Claims[a].Unmounted != rep.Claims[b].Unmounted {
			return rep.Claims[a].Unmounted
		}
		return rep.Claims[a].Namespace < rep.Claims[b].Namespace
	})
	rep.TotalCapacityGB = round(rep.TotalCapacityGB)
	rep.OrphanedCapacityGB = round(rep.OrphanedCapacityGB)
	return rep, nil
}
