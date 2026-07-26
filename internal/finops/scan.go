package finops

import (
	"context"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Scan computes the FinOps report: per-pod reserved vs used, waste level, and a
// monthly cost estimate. Usage comes from metrics-server; if it's unavailable,
// the report still lists reservations and costs but can't compute the waste gap
// (HasMetrics=false), which the UI surfaces honestly.
func Scan(ctx context.Context, kube kubernetes.Interface, metrics metricsv.Interface, prices Prices) (*Report, error) {
	if prices == (Prices{}) {
		prices = DefaultPrices
	}
	rep := &Report{Pods: []PodCost{}, Prices: prices}

	pods, err := kube.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	// Live usage per pod (summed across containers), if metrics-server is up.
	usage := map[string]struct{ cpu, mem float64 }{}
	if metrics != nil {
		if pm, err := metrics.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{}); err == nil {
			rep.MetricsAvailable = true
			for i := range pm.Items {
				m := &pm.Items[i]
				var cpu, mem float64
				for _, c := range m.Containers {
					cpu += cores(c.Usage.Cpu())
					mem += gib(c.Usage.Memory())
				}
				usage[m.Namespace+"/"+m.Name] = struct{ cpu, mem float64 }{cpu, mem}
			}
		}
	}

	for i := range pods.Items {
		p := &pods.Items[i]
		pc := podCost(p, usage[p.Namespace+"/"+p.Name], rep.MetricsAvailable, prices)
		rep.Pods = append(rep.Pods, pc)
		rep.TotalMonthly += pc.MonthlyCost
		rep.WastedMonthly += pc.WastedMonthly
	}

	// Worst waste first — that's where the money is.
	sort.SliceStable(rep.Pods, func(a, b int) bool {
		return rep.Pods[a].WastedMonthly > rep.Pods[b].WastedMonthly
	})

	// Roll up per namespace for the treemap.
	byNS := map[string]*NamespaceCost{}
	for _, pc := range rep.Pods {
		ns := byNS[pc.Namespace]
		if ns == nil {
			ns = &NamespaceCost{Namespace: pc.Namespace}
			byNS[pc.Namespace] = ns
		}
		ns.MonthlyCost += pc.MonthlyCost
		ns.WastedMonthly += pc.WastedMonthly
		ns.Pods++
	}
	for _, ns := range byNS {
		ns.MonthlyCost = round(ns.MonthlyCost)
		ns.WastedMonthly = round(ns.WastedMonthly)
		rep.Namespaces = append(rep.Namespaces, *ns)
	}
	sort.SliceStable(rep.Namespaces, func(a, b int) bool {
		return rep.Namespaces[a].MonthlyCost > rep.Namespaces[b].MonthlyCost
	})
	return rep, nil
}

// podCost sums the pod's container requests, compares to live usage, and derives
// the waste level + a right-sizing recommendation.
func podCost(p *corev1.Pod, used struct{ cpu, mem float64 }, hasMetrics bool, prices Prices) PodCost {
	var cpuReq, memReq float64
	anyRequest := false
	for _, c := range p.Spec.Containers {
		if r := c.Resources.Requests; r != nil {
			if q := r.Cpu(); q != nil && !q.IsZero() {
				cpuReq += cores(q)
				anyRequest = true
			}
			if q := r.Memory(); q != nil && !q.IsZero() {
				memReq += gib(q)
				anyRequest = true
			}
		}
	}

	pc := PodCost{
		Name: p.Name, Namespace: p.Namespace,
		CPURequest: round(cpuReq), MemRequestGB: round(memReq),
		CPUUsage: round(used.cpu), MemUsageGB: round(used.mem),
		HasMetrics:  hasMetrics,
		MonthlyCost: round(prices.monthlyCost(cpuReq, memReq)),
	}

	// No requests at all: unbounded — it can consume the node and can't be
	// scheduled or costed predictably. That's its own kind of problem.
	if !anyRequest {
		pc.Level = WasteUnbounded
		pc.Recommendation = "No CPU/memory requests set. Add requests so the scheduler can place it and so its cost is predictable."
		return pc
	}

	if !hasMetrics {
		pc.Level = WasteNone
		pc.Recommendation = "Install metrics-server to compare reserved vs actually-used and get a right-sizing hint."
		return pc
	}

	// The waste gap: reserved minus used, valued at the price.
	cpuGap := cpuReq - used.cpu
	memGap := memReq - used.mem
	if cpuGap < 0 {
		cpuGap = 0
	}
	if memGap < 0 {
		memGap = 0
	}
	pc.WastedMonthly = round(prices.monthlyCost(cpuGap, memGap))

	// Classify by how much of the reservation is idle.
	cpuRatio := usageRatio(used.cpu, cpuReq)
	memRatio := usageRatio(used.mem, memReq)
	worst := minRatio(cpuRatio, memRatio)
	switch {
	case worst < 0.20:
		pc.Level = WasteHigh
		pc.Recommendation = fmt.Sprintf("Using ~%.0f%% CPU / ~%.0f%% memory of what it reserves. Lower requests to ~%.2f cores / %.2f GB (with headroom) to reclaim capacity.",
			cpuRatio*100, memRatio*100, rightSize(used.cpu), rightSize(used.mem))
	case worst < 0.50:
		pc.Level = WasteModerate
		pc.Recommendation = fmt.Sprintf("Using ~%.0f%% CPU / ~%.0f%% memory of its reservation — some room to right-size.", cpuRatio*100, memRatio*100)
	default:
		pc.Level = WasteNone
		pc.Recommendation = "Reservation is close to actual usage — well sized."
	}
	return pc
}

// --- unit helpers ------------------------------------------------------------

func cores(q *resource.Quantity) float64 {
	if q == nil {
		return 0
	}
	return float64(q.MilliValue()) / 1000.0
}

func gib(q *resource.Quantity) float64 {
	if q == nil {
		return 0
	}
	return float64(q.Value()) / (1024 * 1024 * 1024)
}

func usageRatio(used, reserved float64) float64 {
	if reserved <= 0 {
		return 1 // nothing reserved → not "wasteful" in this dimension
	}
	return used / reserved
}

func minRatio(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// rightSize suggests a request with ~30% headroom over observed usage.
func rightSize(used float64) float64 { return round(used * 1.3) }

func round(f float64) float64 { return float64(int(f*100+0.5)) / 100 }
