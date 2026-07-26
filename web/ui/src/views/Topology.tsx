import { useEffect, useState } from 'react'
import { api, type Topology as Topo } from '../api'
import { Card, Spinner, ErrorNote } from '../lib'
import { useT } from '../i18n'
import { Layered } from './topo/Layered'
import { ByNamespace } from './topo/ByNamespace'
import { DependencyGraph } from './topo/DependencyGraph'
import { ByNode } from './topo/ByNode'

// Topology offers several lenses over the same cluster graph, so you can pick the
// one that fits: namespaces (how you reason about prod), a workload graph (the
// wiring), by-node (what runs where), and a heatmap (fleet health at scale).
// POC note: the four variants are kept side-by-side behind a selector so we can
// compare them on a real cluster and keep the winners.
type Lens = 'layered' | 'namespace' | 'graph' | 'node' | 'heatmap'

const LENSES: { id: Lens; key: string }[] = [
  { id: 'layered', key: 'topo.lens.layered' },
  { id: 'namespace', key: 'topo.lens.namespace' },
  { id: 'graph', key: 'topo.lens.graph' },
  { id: 'node', key: 'topo.lens.node' },
  { id: 'heatmap', key: 'topo.lens.heatmap' },
]

export function Topology() {
  const { t } = useT()
  const [topo, setTopo] = useState<Topo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [lens, setLensState] = useState<Lens>(() => {
    const q = new URLSearchParams(location.search).get('lens')
    return LENSES.some((l) => l.id === q) ? (q as Lens) : 'layered'
  })
  const setLens = (l: Lens) => {
    setLensState(l)
    const u = new URL(location.href)
    u.searchParams.set('lens', l)
    history.replaceState(null, '', u)
  }

  useEffect(() => {
    api.topology().then(setTopo).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!topo) return <Spinner />

  const totalPods = topo.nodes.reduce((s, n) => s + n.pods.length, 0)
  const unhealthy = topo.nodes.reduce((s, n) => s + n.pods.filter((p) => !p.healthy).length, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5 text-xs">
          {LENSES.map((l) => (
            <button
              key={l.id}
              onClick={() => setLens(l.id)}
              className={
                'rounded px-3 py-1 transition ' +
                (lens === l.id
                  ? 'bg-[var(--color-accent)] text-black font-medium'
                  : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]')
              }
            >
              {t(l.key)}
            </button>
          ))}
        </div>
        <div className="ml-auto text-xs text-[var(--color-ink-faint)]">
          {t(topo.nodes.length > 1 ? 'topo.nodes' : 'topo.node', { n: topo.nodes.length })} · {t('topo.pods', { n: totalPods })}
          {unhealthy > 0 && <span className="text-[var(--color-crit)]"> · {t('topo.unhealthy', { n: unhealthy })}</span>}
        </div>
      </div>

      {lens === 'layered' && <Layered />}
      {lens === 'namespace' && <ByNamespace topo={topo} />}
      {lens === 'graph' && (
        <Card className="p-4 overflow-auto">
          <DependencyGraph topo={topo} />
        </Card>
      )}
      {lens === 'node' && <ByNode topo={topo} />}
      {lens === 'heatmap' && <HeatmapView topo={topo} />}
    </div>
  )
}

// Heatmap lens: one tile per node, one cell per pod, colored by health. Cell size
// shrinks as pod count grows, so a 500-pod node still fits.
function HeatmapView({ topo }: { topo: Topo }) {
  const maxPods = Math.max(...topo.nodes.map((n) => n.pods.length), 1)
  const perRow = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(maxPods))))
  const cell = maxPods > 200 ? 8 : maxPods > 60 ? 12 : 16
  const gap = cell > 12 ? 3 : 2

  return (
    <div className="flex flex-wrap gap-4">
      {topo.nodes.map((n) => {
        const rows = Math.ceil(Math.max(n.pods.length, 1) / perRow)
        const ok = n.pods.filter((p) => p.healthy).length
        const bad = n.pods.length - ok
        return (
          <div
            key={n.name}
            className="rounded-lg border p-3"
            style={{ borderColor: n.ready ? 'var(--color-border)' : 'var(--color-crit)', background: 'var(--color-surface)' }}
          >
            <div className="mb-2 flex items-center justify-between gap-6">
              <span className="mono text-xs font-semibold text-[var(--color-ink)]">
                {n.name.length > 28 ? n.name.slice(0, 28) + '…' : n.name}
              </span>
              <span className="text-[10px] text-[var(--color-ink-faint)]">
                <span className="text-[var(--color-ok)]">{ok} ok</span>
                {bad > 0 && <span className="text-[var(--color-crit)]"> · {bad} bad</span>}
              </span>
            </div>
            <svg width={perRow * (cell + gap)} height={rows * (cell + gap)}>
              {n.pods.map((p, i) => (
                <rect
                  key={`${p.namespace}/${p.name}`}
                  x={(i % perRow) * (cell + gap)}
                  y={Math.floor(i / perRow) * (cell + gap)}
                  width={cell} height={cell} rx={2}
                  fill={p.healthy ? 'var(--color-ok)' : 'var(--color-crit)'}
                  opacity={p.healthy ? 0.85 : 1}
                >
                  <title>{p.namespace}/{p.name} — {p.status}</title>
                </rect>
              ))}
            </svg>
          </div>
        )
      })}
    </div>
  )
}
