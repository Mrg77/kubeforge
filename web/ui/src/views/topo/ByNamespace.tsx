import { useMemo } from 'react'
import type { Topology } from '../../api'
import { flatten, workloads, byNamespace, nsColor, podColor, kindGlyph } from './shared'

// Variant 1 — By namespace. The way a platform engineer actually reasons about
// prod: one card per namespace, and inside it one row per workload (Deployment/
// StatefulSet/…) with its replica dots and the services fronting it. No global
// edges to turn into spaghetti — everything a namespace needs is inside its card.
export function ByNamespace({ topo }: { topo: Topology }) {
  const groups = useMemo(() => {
    const pods = flatten(topo)
    const wl = workloads(pods)
    const byNs = byNamespace(wl)
    // services per namespace, so we can tag the workloads they select
    const svcByNs = byNamespace(topo.services)
    // order namespaces by pod count desc
    const order = [...byNs.entries()]
      .map(([ns, w]) => ({ ns, w, pods: w.reduce((s, x) => s + x.total, 0) }))
      .sort((a, b) => b.pods - a.pods)
    return order.map(({ ns, w }) => ({
      ns,
      workloads: w.sort((a, b) => b.total - a.total),
      services: svcByNs.get(ns) ?? [],
    }))
  }, [topo])

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
      {groups.map((g) => {
        const color = nsColor(g.ns)
        const bad = g.workloads.reduce((s, w) => s + (w.total - w.healthy), 0)
        return (
          <div
            key={g.ns}
            className="flex flex-col rounded-xl border bg-[var(--color-surface)] p-4"
            style={{ borderColor: 'var(--color-border)', borderTopColor: color, borderTopWidth: 3 }}
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="mono text-sm font-semibold" style={{ color }}>{g.ns}</span>
              <span className="text-[11px] text-[var(--color-ink-faint)]">
                {g.workloads.length} workloads
              </span>
              {bad > 0 && (
                <span className="ml-auto rounded-full bg-[var(--color-crit)] px-1.5 text-[10px] text-white">
                  {bad} down
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2.5">
              {g.workloads.map((w) => {
                const svc = g.services.filter((s) => s.podKeys.some((k) => w.pods.some((p) => p.key === k)))
                return (
                  <div key={w.key} className="rounded-lg bg-[var(--color-bg)] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--color-ink-faint)]" title={w.kind}>{kindGlyph(w.kind)}</span>
                      <span className="mono text-xs text-[var(--color-ink)]">{w.name}</span>
                      <span className="text-[10px] text-[var(--color-ink-faint)]">{w.healthy}/{w.total}</span>
                      {svc.map((s) => (
                        <span
                          key={s.name}
                          className="ml-1 rounded px-1.5 text-[9px]"
                          style={{ color: 'var(--color-accent)', background: 'var(--color-accent-soft)' }}
                          title={`${s.type} service`}
                        >
                          {s.name}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {w.pods.map((p) => (
                        <span
                          key={p.key}
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: podColor(p) }}
                          title={`${p.name} — ${p.status}`}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
