package history

import (
	"context"
	"log"
	"time"

	"github.com/Mrg77/kubeforge/internal/cluster"
	"github.com/Mrg77/kubeforge/internal/finops"
	"github.com/Mrg77/kubeforge/internal/secops"
)

// Collector periodically snapshots the cluster's posture into the history store,
// so trends have data to work with. It runs in the background for the life of
// the server and is best-effort: a failed collection is logged and skipped, it
// never affects the running app.
type Collector struct {
	cluster *cluster.Client
	store   *Store
	every   time.Duration
}

// NewCollector builds a collector. every is how often to snapshot (e.g. 5m).
func NewCollector(c *cluster.Client, store *Store, every time.Duration) *Collector {
	if every <= 0 {
		every = 5 * time.Minute
	}
	return &Collector{cluster: c, store: store, every: every}
}

// Run takes one snapshot immediately (so trends start populating right away),
// then one every `every` until ctx is cancelled.
func (c *Collector) Run(ctx context.Context) {
	c.collectOnce(ctx)
	t := time.NewTicker(c.every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.collectOnce(ctx)
		}
	}
}

// collectOnce runs the health/secops/finops scans and records a summary.
func (c *Collector) collectOnce(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	snap := Snapshot{Context: c.cluster.Context, Time: time.Now().UTC()}

	if pods, err := c.cluster.Pods(cctx, ""); err == nil {
		snap.Pods = len(pods)
		for _, p := range pods {
			if !p.Healthy {
				snap.Unhealthy++
			}
			snap.Restarts += int(p.Restarts)
		}
	}
	if rep, err := secops.Scan(cctx, c.cluster.Kube); err == nil {
		snap.SecCritical = rep.Counts.Critical
		snap.SecHigh = rep.Counts.High
		snap.SecMedium = rep.Counts.Medium
	}
	if rep, err := finops.Scan(cctx, c.cluster.Kube, c.cluster.Metrics, finops.Prices{}); err == nil {
		snap.MonthlyReserved = rep.TotalMonthly
		snap.MonthlyWasted = rep.WastedMonthly
	}

	if err := c.store.Record(cctx, snap); err != nil {
		log.Printf("history: failed to record snapshot: %v", err)
	}
}
