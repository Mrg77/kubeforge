// Package finops is KubeForge's cost-and-waste engine. It answers the question
// every platform team eventually asks: "where am I wasting money?" — without a
// billing integration, by reasoning about the two things that actually drive
// Kubernetes waste: resources requested but not used, and resources with no
// limits at all.
//
// The core insight (and the reason this is useful offline): a pod that requests
// 2 CPU and uses 0.1 reserves capacity nobody gets back. Multiply across a
// cluster and that's the bulk of the "83% of container spend is idle" figure.
// KubeForge computes the gap from live usage (metrics-server) vs requests, and
// turns it into a right-sizing recommendation and a rough monthly cost estimate.
//
// Honest scope: cost here is an ESTIMATE from a configurable price-per-core /
// per-GB, not a cloud bill. It's meant to rank waste and guide right-sizing, not
// to reconcile invoices.
package finops

// Money-ish estimate is deliberately simple and configurable. These defaults
// are rough public on-demand averages; the point is relative ranking, not
// invoice accuracy. Exposed so the UI/CLI can override per environment.
type Prices struct {
	// PerCPUHour is the hourly cost of one vCPU. USD-ish.
	PerCPUHour float64
	// PerGBHour is the hourly cost of one GB of memory. USD-ish.
	PerGBHour float64
}

// DefaultPrices are conservative on-demand-ish averages.
var DefaultPrices = Prices{PerCPUHour: 0.031, PerGBHour: 0.004}

const hoursPerMonth = 730.0

// WasteLevel classifies how over-provisioned a workload is.
type WasteLevel string

const (
	WasteNone      WasteLevel = "ok"
	WasteModerate  WasteLevel = "moderate"
	WasteHigh      WasteLevel = "high"
	WasteUnbounded WasteLevel = "unbounded" // no requests/limits at all
)

// PodCost is the per-pod FinOps view: what it reserves, what it actually uses,
// the gap, a right-sizing hint, and the estimated monthly cost of the waste.
type PodCost struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`

	CPURequest   float64 `json:"cpuRequest"`   // cores reserved
	CPUUsage     float64 `json:"cpuUsage"`     // cores actually used (from metrics)
	MemRequestGB float64 `json:"memRequestGB"` // GB reserved
	MemUsageGB   float64 `json:"memUsageGB"`   // GB actually used

	Level          WasteLevel `json:"level"`
	MonthlyCost    float64    `json:"monthlyCost"`    // estimated $/mo for what it RESERVES
	WastedMonthly  float64    `json:"wastedMonthly"`  // estimated $/mo for the reserved-but-unused gap
	Recommendation string     `json:"recommendation"` // plain right-sizing advice
	HasMetrics     bool       `json:"hasMetrics"`     // false when usage is unknown
}

// Report is the whole-cluster FinOps summary.
type Report struct {
	Pods             []PodCost `json:"pods"`
	TotalMonthly     float64   `json:"totalMonthly"`  // estimated $/mo reserved across all pods
	WastedMonthly    float64   `json:"wastedMonthly"` // estimated $/mo wasted (reserved-unused)
	MetricsAvailable bool      `json:"metricsAvailable"`
	Prices           Prices    `json:"prices"`
}

// monthlyCost estimates $/mo for a given amount of reserved CPU cores + memory GB.
func (p Prices) monthlyCost(cpuCores, memGB float64) float64 {
	return (cpuCores*p.PerCPUHour + memGB*p.PerGBHour) * hoursPerMonth
}
