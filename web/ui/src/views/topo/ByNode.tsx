import { useMemo, useState } from 'react'
import type { Topology } from '../../api'
import { nsColor, podColor } from './shared'

// Variant 3 — By node, fixed. Keeps the "what runs where" framing but fixes the
// original graph's faults: pods inside each node are grouped and tinted by
// namespace (so you can tell postgres from web), each node wraps its pods into a
// tidy grid, and there are no permanent service spaghetti — the service list is
// a legend you hover to light up its pods.
export function ByNode({ topo }: { topo: Topology }) {
  const [hoverSvc, setHoverSvc] = useState<string | null>(null)

  const svcPods = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const s of topo.services) m.set(`${s.namespace}/${s.name}`, new Set(s.podKeys))
    return m
  }, [topo])
  const activeSet = hoverSvc ? svcPods.get(hoverSvc) : null

  // namespaces present, for the legend tints
  const namespaces = useMemo(() => {
    const set = new Set<string>()
    topo.nodes.forEach((n) => n.pods.forEach((p) => set.add(p.namespace)))
    return [...set].sort()
  }, [topo])

  return (
    <div className="flex flex-col gap-4">
      {/* services as an interactive legend, wrapping freely */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-[var(--color-ink-faint)]">services:</span>
        {topo.services.map((s) => {
          const key = `${s.namespace}/${s.name}`
          return (
            <button
              key={key}
              onMouseEnter={() => setHoverSvc(key)}
              onMouseLeave={() => setHoverSvc(null)}
              className="rounded-full border px-2 py-0.5 text-[10px] transition"
              style={{
                borderColor: hoverSvc === key ? 'var(--color-accent)' : 'var(--color-border)',
                color: hoverSvc === key ? 'var(--color-accent)' : 'var(--color-ink-dim)',
                background: hoverSvc === key ? 'var(--color-accent-soft)' : 'transparent',
              }}
              title={`${s.type} · ${s.podKeys.length} pods`}
            >
              {s.name}
            </button>
          )
        })}
      </div>

      {/* namespace tint legend */}
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--color-ink-faint)]">
        {namespaces.map((ns) => (
          <span key={ns} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: nsColor(ns) }} />
            {ns}
          </span>
        ))}
      </div>

      {/* node cards */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {topo.nodes.map((n) => {
          // group this node's pods by namespace
          const byNs = new Map<string, typeof n.pods>()
          for (const p of n.pods) {
            const arr = byNs.get(p.namespace) ?? []
            arr.push(p)
            byNs.set(p.namespace, arr)
          }
          const order = [...byNs.entries()].sort((a, b) => b[1].length - a[1].length)
          return (
            <div
              key={n.name}
              className="rounded-xl border bg-[var(--color-surface)] p-3"
              style={{ borderColor: n.ready ? 'var(--color-border)' : 'var(--color-crit)' }}
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="mono text-xs font-semibold text-[var(--color-ink)]" title={n.name}>
                  {n.name.length > 26 ? n.name.slice(0, 26) + '…' : n.name}
                </span>
                <span className="text-[10px] text-[var(--color-ink-faint)]">
                  {n.pods.length} pods · {n.ready ? 'Ready' : 'NotReady'}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {order.map(([ns, pods]) => (
                  <div key={ns} className="flex items-start gap-2">
                    <span
                      className="mt-0.5 shrink-0 rounded px-1 text-[9px]"
                      style={{ color: nsColor(ns), background: `color-mix(in srgb, ${nsColor(ns)} 15%, transparent)` }}
                    >
                      {ns}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {pods.map((p) => {
                        const key = `${p.namespace}/${p.name}`
                        const active = activeSet?.has(key)
                        const dim = activeSet && !active
                        return (
                          <span
                            key={key}
                            className="h-3 w-3 rounded-full transition"
                            style={{
                              background: podColor(p),
                              outline: active ? '2px solid var(--color-accent)' : 'none',
                              outlineOffset: 1,
                              opacity: dim ? 0.2 : 1,
                            }}
                            title={`${p.name} — ${p.status}`}
                          />
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
