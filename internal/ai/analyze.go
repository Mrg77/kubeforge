package ai

import (
	"context"
	"fmt"
	"strings"
	"time"

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
// cluster is getting better or worse, and what's driving the change. Rather than
// dumping every raw snapshot (which makes the model recite numbers), it computes
// the start→now deltas and the sharpest change point, and asks for a plain,
// actionable read — no "X went from 1 to 2" narration.
func (c *Client) AnalyzeTrends(ctx context.Context, snaps []history.Snapshot, lang string) (string, error) {
	if len(snaps) < 2 {
		return "", fmt.Errorf("not enough history yet to analyze trends (need at least 2 snapshots)")
	}
	first, last := snaps[0], snaps[len(snaps)-1]
	span := last.Time.Sub(first.Time)

	// Find the single snapshot with the biggest jump in a "badness" score vs the
	// previous one — usually the moment something regressed.
	badness := func(s history.Snapshot) float64 {
		return float64(s.SecCritical*10+s.SecHigh*4+s.SecMedium) + s.MonthlyWasted/10 + float64(s.Unhealthy*3)
	}
	jumpIdx, jumpDelta := 0, 0.0
	for i := 1; i < len(snaps); i++ {
		if d := badness(snaps[i]) - badness(snaps[i-1]); d > jumpDelta {
			jumpDelta, jumpIdx = d, i
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Cluster posture change over the last %s (%d snapshots).\n\n", humanDur(span), len(snaps))
	fmt.Fprintf(&b, "START (%s) → NOW (%s):\n", first.Time.Format("Jan 2 15:04"), last.Time.Format("Jan 2 15:04"))
	fmt.Fprintf(&b, "- Unhealthy pods: %d → %d\n", first.Unhealthy, last.Unhealthy)
	fmt.Fprintf(&b, "- Security (your workloads): critical %d→%d, high %d→%d, medium %d→%d\n",
		first.SecCritical, last.SecCritical, first.SecHigh, last.SecHigh, first.SecMedium, last.SecMedium)
	fmt.Fprintf(&b, "- Estimated wasted cost: $%.0f/mo → $%.0f/mo (of $%.0f reserved)\n",
		first.MonthlyWasted, last.MonthlyWasted, last.MonthlyReserved)
	fmt.Fprintf(&b, "- Pod restarts (per snapshot): %d → %d\n", first.Restarts, last.Restarts)
	if jumpDelta > 0 && jumpIdx > 0 {
		fmt.Fprintf(&b, "\nSharpest regression: around %s, posture worsened noticeably in one step.\n",
			snaps[jumpIdx].Time.Format("Jan 2 15:04"))
	}

	user := b.String() + `
Write a short trend read for a DevOps engineer. Rules:
- Lead with the VERDICT: is the cluster getting better or worse, and does it need attention now?
- Explain what likely DROVE the change in plain terms (e.g. "a workload was deployed with no limits and privileged access"), not a play-by-play of the numbers. Do NOT narrate "X went from 1 to 2".
- End with 1-2 concrete next steps.
- If the change lines up at one time, say a deployment/change probably caused it and to check what shipped then.
- Costs are estimates, not a bill. Keep it under ~120 words.`
	return c.Complete(ctx, systemPromptFor(lang), user)
}

// humanDur renders a duration compactly ("3h", "2d", "45m").
func humanDur(d time.Duration) string {
	switch {
	case d >= 48*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours())/24)
	case d >= time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
}
