// Package secops is KubeForge's deterministic security-posture engine. It reads
// the live cluster and flags the settings that make an attacker's life easy:
// over-broad RBAC, lax pod security (privileged, runAsRoot, hostNetwork),
// missing NetworkPolicies, mutable image tags, and risky Secrets exposure.
//
// It is rule-based and offline by design — the same input always yields the
// same findings, so a scan is reproducible and can gate CI. The AI layer (opt-in)
// sits ON TOP to explain and prioritize these findings, never to find them.
//
// Honest scope: this is posture (how things are configured), not runtime threat
// detection. A clean report means "no obvious misconfiguration we check for",
// not "your cluster is secure".
package secops

// Severity is a coarse, sortable risk level.
type Severity int

const (
	SevInfo Severity = iota
	SevLow
	SevMedium
	SevHigh
	SevCritical
)

func (s Severity) String() string {
	switch s {
	case SevCritical:
		return "CRITICAL"
	case SevHigh:
		return "HIGH"
	case SevMedium:
		return "MEDIUM"
	case SevLow:
		return "LOW"
	default:
		return "INFO"
	}
}

// Category groups findings for the UI (RBAC, PodSecurity, Network, Images…).
type Category string

const (
	CatRBAC        Category = "RBAC"
	CatPodSecurity Category = "Pod Security"
	CatNetwork     Category = "Network"
	CatImages      Category = "Images"
	CatSecrets     Category = "Secrets"
)

// Finding is one security-posture observation about one object.
type Finding struct {
	Category      Category `json:"category"`
	Severity      Severity `json:"-"`
	SeverityLabel string   `json:"severity"`
	Title         string   `json:"title"`  // short problem statement
	Object        string   `json:"object"` // "namespace/name (Kind)"
	Namespace     string   `json:"namespace,omitempty"`
	Detail        string   `json:"detail"` // why it's risky + what to do
}

func mk(cat Category, sev Severity, title, object, ns, detail string) Finding {
	return Finding{
		Category:      cat,
		Severity:      sev,
		SeverityLabel: sev.String(),
		Title:         title,
		Object:        object,
		Namespace:     ns,
		Detail:        detail,
	}
}

// Report is a full posture scan.
type Report struct {
	Findings []Finding     `json:"findings"`
	Counts   SeverityCount `json:"counts"`
	Scanned  ScanScope     `json:"scanned"`
}

// SeverityCount is the tally the UI shows as a summary.
type SeverityCount struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Info     int `json:"info"`
}

// ScanScope reports what was inspected, so the report is honest about coverage.
type ScanScope struct {
	Pods            int `json:"pods"`
	Namespaces      int `json:"namespaces"`
	ClusterRoleBind int `json:"clusterRoleBindings"`
}

// tally computes the severity counts from findings.
func (r *Report) tally() {
	for _, f := range r.Findings {
		switch f.Severity {
		case SevCritical:
			r.Counts.Critical++
		case SevHigh:
			r.Counts.High++
		case SevMedium:
			r.Counts.Medium++
		case SevLow:
			r.Counts.Low++
		default:
			r.Counts.Info++
		}
	}
}
