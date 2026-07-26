package ai

import (
	"context"
	"fmt"
	"strings"

	"github.com/Mrg77/kubeforge/internal/finops"
	"github.com/Mrg77/kubeforge/internal/history"
	"github.com/Mrg77/kubeforge/internal/secops"
)

// systemPromptFor anchors the model in KubeForge's honest, ops-focused voice and
// pins the response language to the user's UI locale — so a French UI gets a
// French brief, not English.
func systemPromptFor(lang string) string {
	base := `You are the analysis assistant inside KubeForge, a Kubernetes console.
The findings you're given were produced by DETERMINISTIC scanners — you do not
detect anything, you explain and prioritize. Be concise, concrete, and honest.
Speak to a DevOps/SRE. No fluff, no hedging boilerplate. Prefer specific actions
naming the actual workload ("right-size the 'web' deployment") over generic
advice ("right-size some pods"). If something isn't a real problem, say so.
Never invent findings, names, or numbers that aren't in the data.
Honesty about cost: the dollar figures are a ROUGH ESTIMATE from a configurable
price, not a cloud bill — call them "estimated", and don't promise recovering
100% of the waste (right-sizing leaves headroom). System namespaces
(kube-system, kindnet, kube-proxy) are privileged BY DESIGN — don't flag them as
problems the operator must fix.`
	if lang == "fr" {
		return base + "\nRÉPONDS EN FRANÇAIS. Rédige toute ta réponse en français."
	}
	return base + "\nRespond in English."
}

// Summarize turns the current posture (health + security + cost) into a short,
// prioritized brief: the state of the cluster and the few things to fix first.
// It sends only aggregated findings — never raw cluster objects or secrets.
func (c *Client) Summarize(ctx context.Context, sec *secops.Report, fin *finops.Report, pods, unhealthy int, lang string) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "Cluster snapshot:\n")
	fmt.Fprintf(&b, "- Health: %d pods, %d unhealthy.\n", pods, unhealthy)

	if sec != nil {
		// Report YOUR findings (non-system) prominently — system pods are
		// privileged by design and the model shouldn't chase them.
		fmt.Fprintf(&b, "- Security (your workloads, excluding system namespaces): %d critical, %d high, %d medium.\n",
			sec.OwnCounts.Critical, sec.OwnCounts.High, sec.OwnCounts.Medium)
		fmt.Fprintf(&b, "  (whole cluster incl. system: %d critical, %d high)\n", sec.Counts.Critical, sec.Counts.High)
		// Name the top non-system findings so advice can be specific.
		shown := 0
		for _, f := range sec.Findings {
			if f.System || shown >= 8 {
				continue
			}
			fmt.Fprintf(&b, "  [%s] %s — %s\n", f.SeverityLabel, f.Title, f.Object)
			shown++
		}
	}

	if fin != nil {
		fmt.Fprintf(&b, "- Cost (ESTIMATED, not a real bill): ~$%.0f/mo reserved, ~$%.0f/mo of that is reserved-but-unused.\n",
			fin.TotalMonthly, fin.WastedMonthly)
		if fin.MetricsAvailable && len(fin.Workloads) > 0 {
			fmt.Fprintf(&b, "  Top waste by WORKLOAD (name · reserved→used CPU · $wasted/mo):\n")
			n := 0
			for _, w := range fin.Workloads { // already sorted worst-waste first
				if w.WastedMonthly <= 0 || n >= 6 {
					break
				}
				fmt.Fprintf(&b, "    %s/%s (%s) · %.2f→%.2f CPU · ~$%.0f/mo\n",
					w.Namespace, w.Name, w.Kind, w.CPURequest, w.CPUUsage, w.WastedMonthly)
				n++
			}
		} else if !fin.MetricsAvailable {
			fmt.Fprintf(&b, "  (metrics-server not installed — used-vs-reserved unknown, so waste can't be measured precisely)\n")
		}
	}

	user := b.String() + `
Write a brief for the operator:
1. One or two sentences on the overall state — focus on THEIR workloads, not system pods.
2. A prioritized list of the 3-5 most important actions, most urgent first, each naming the specific workload/resource and a one-line "why".
Keep it tight. Be honest that costs are estimates.`
	return c.Complete(ctx, systemPromptFor(lang), user)
}

// AnalyzeTrends reads the history snapshots and tells the operator whether the
// cluster is getting better or worse, and what's driving the change.
func (c *Client) AnalyzeTrends(ctx context.Context, snaps []history.Snapshot, lang string) (string, error) {
	if len(snaps) < 2 {
		return "", fmt.Errorf("not enough history yet to analyze trends (need at least 2 snapshots)")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Cluster posture over time (oldest to newest), one line per snapshot:\n")
	for _, s := range snaps {
		fmt.Fprintf(&b, "%s | pods=%d unhealthy=%d restarts=%d | sec: crit=%d high=%d med=%d | cost: reserved=$%.0f wasted=$%.0f\n",
			s.Time.Format("2006-01-02 15:04"), s.Pods, s.Unhealthy, s.Restarts,
			s.SecCritical, s.SecHigh, s.SecMedium, s.MonthlyReserved, s.MonthlyWasted)
	}
	user := b.String() + `
Analyze the trend:
1. Is the cluster getting healthier, safer, and cheaper — or worse? State the direction plainly.
2. Call out the biggest movements (e.g. "wasted spend rose 40% then recovered", "critical findings doubled").
3. One or two concrete things to watch or act on.
Be specific about the numbers.`
	return c.Complete(ctx, systemPromptFor(lang), user)
}
