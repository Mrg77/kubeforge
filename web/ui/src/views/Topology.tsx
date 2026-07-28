import { useEffect, useState } from 'react'
import { api, type Topology as Topo, type TopoPod, type GraphNode } from '../api'
import { Spinner, ErrorNote } from '../lib'
import { useT } from '../i18n'
import { Layered, ObjectDrawer } from './topo/Layered'

// Topology has two lenses: the Resource stack (the flagship — a namespace drawn
// from traffic-in down to config/RBAC/storage) and a Heatmap for fleet health at
// scale (500+ pods, where the stack would overflow). The stack is the default.
type Lens = 'layered' | 'heatmap'

const LENSES: { id: Lens; key: string }[] = [
  { id: 'layered', key: 'topo.lens.layered' },
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
      {lens === 'heatmap' && <HeatmapView topo={topo} />}
    </div>
  )
}

// Heatmap lens: one tile per node, one cell per pod, colored by health — a
// fleet-status view that stays readable at 500+ pods. Cells sort unhealthy-first
// so problems cluster in the top-left; hover shows the pod's identity + node +
// restarts; click opens its events/manifest. A restart count tints the cell so
// a flapping-but-Running pod still stands out.
function HeatmapView({ topo }: { topo: Topo }) {
  const { t } = useT()
  const [hover, setHover] = useState<{ p: TopoPod; node: string; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<TopoPod | null>(null)

  const maxPods = Math.max(...topo.nodes.map((n) => n.pods.length), 1)
  const perRow = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(maxPods))))
  const cell = maxPods > 200 ? 9 : maxPods > 60 ? 13 : 18
  const gap = cell > 12 ? 3 : 2

  // unhealthy first, then most-restarted, then by name — problems top-left.
  const sortPods = (pods: TopoPod[]) =>
    [...pods].sort((a, b) =>
      Number(a.healthy) - Number(b.healthy) || b.restarts - a.restarts || a.name.localeCompare(b.name))

  const cellColor = (p: TopoPod) => {
    if (!p.healthy) return 'var(--color-crit)'
    if (p.restarts > 5) return 'var(--color-warn)' // flapping but Running
    return 'var(--color-ok)'
  }

  return (
    <div className="relative flex flex-col gap-3">
      {/* legend */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--color-ink-faint)]">
        <Swatch color="var(--color-ok)" label={t('heat.healthy')} />
        <Swatch color="var(--color-warn)" label={t('heat.restarting')} />
        <Swatch color="var(--color-crit)" label={t('heat.unhealthy')} />
        <span className="ml-auto">{t('heat.hint')}</span>
      </div>

      <div className="flex flex-wrap gap-4">
        {topo.nodes.map((n) => {
          const pods = sortPods(n.pods)
          const rows = Math.ceil(Math.max(pods.length, 1) / perRow)
          const ok = pods.filter((p) => p.healthy).length
          const bad = pods.length - ok
          return (
            <div key={n.name} className="rounded-lg border p-3"
              style={{ borderColor: n.ready ? 'var(--color-border)' : 'var(--color-crit)', background: 'var(--color-surface)' }}>
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
                {pods.map((p, i) => {
                  const cx = (i % perRow) * (cell + gap)
                  const cy = Math.floor(i / perRow) * (cell + gap)
                  const isHover = hover?.p === p
                  return (
                    <rect key={`${p.namespace}/${p.name}`}
                      x={cx} y={cy} width={cell} height={cell} rx={2}
                      fill={cellColor(p)} opacity={p.healthy && p.restarts <= 5 ? 0.85 : 1}
                      stroke={isHover ? 'var(--color-accent)' : 'transparent'} strokeWidth={2}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => setHover({ p, node: n.name, x: e.clientX, y: e.clientY })}
                      onMouseMove={(e) => setHover({ p, node: n.name, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => setSelected(p)} />
                  )
                })}
              </svg>
            </div>
          )
        })}
      </div>

      {/* rich hover tooltip, follows the cursor */}
      {hover && (
        <div className="pointer-events-none fixed z-50 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[11px] shadow-xl"
          style={{ left: Math.min(hover.x + 12, window.innerWidth - 220), top: hover.y + 12 }}>
          <div className="mono font-semibold text-[var(--color-ink)]">{hover.p.name}</div>
          <div className="text-[var(--color-ink-dim)]">{hover.p.namespace} · {hover.p.ownerKind} {hover.p.owner}</div>
          <div className="mt-0.5 flex gap-2">
            <span style={{ color: hover.p.healthy ? 'var(--color-ok)' : 'var(--color-crit)' }}>{hover.p.status}</span>
            <span className="text-[var(--color-ink-faint)]">· {hover.node}</span>
            {hover.p.restarts > 0 && <span className="text-[var(--color-warn)]">· ↻{hover.p.restarts}</span>}
          </div>
        </div>
      )}

      {/* click → the same detail drawer the Resource stack uses */}
      {selected && (
        <ObjectDrawer
          node={podToNode(selected)}
          namespace={selected.namespace}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

// podToNode adapts a heatmap pod into the GraphNode the shared drawer expects.
function podToNode(p: TopoPod): GraphNode {
  return {
    id: `Pod/${p.namespace}/${p.name}`, kind: 'Pod', name: p.name,
    layer: 'pod', healthy: p.healthy, detail: p.status,
    info: [
      { k: 'Status', v: p.status },
      { k: 'Workload', v: `${p.ownerKind} ${p.owner}` },
      { k: 'Restarts', v: String(p.restarts) },
    ],
  }
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )
}
