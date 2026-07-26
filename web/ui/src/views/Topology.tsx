import { useEffect, useMemo, useState } from 'react'
import { api, type Topology as Topo } from '../api'
import { Card, Spinner, ErrorNote } from '../lib'

// Topology has two lenses over the same cluster graph:
//   • Graph   — the wiring: services → the pods they select → the node each runs
//     on. Hovering a service lights up its whole path. This is the picture k9s
//     (a table) and Lens (a resource tree) never draw: how traffic actually
//     reaches your pods.
//   • Heatmap — the fleet: one tile per node, one cell per pod, colored by
//     health. Stays readable at 500+ pods where the graph would turn to soup.
// Both are plain SVG — no chart lib — so they stay light and fully themable.

type Lens = 'graph' | 'heatmap'

export function Topology() {
  const [topo, setTopo] = useState<Topo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [lens, setLensState] = useState<Lens>(
    () => (new URLSearchParams(location.search).get('lens') === 'heatmap' ? 'heatmap' : 'graph'),
  )
  // Keep the lens in the URL so a view is shareable/deep-linkable, like ?tab=.
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
  const unhealthy = topo.nodes.reduce(
    (s, n) => s + n.pods.filter((p) => !p.healthy).length,
    0,
  )
  // Auto-suggest the heatmap for large fleets — but never override a user choice.
  const dense = totalPods > 80

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <LensToggle lens={lens} setLens={setLens} />
        <div className="flex items-center gap-4 text-xs text-[var(--color-ink-dim)]">
          <Legend color="var(--color-ok)" label="healthy" />
          <Legend color="var(--color-crit)" label="unhealthy" />
          {lens === 'graph' && <Legend color="var(--color-info)" label="node" square />}
          {lens === 'graph' && <Legend color="var(--color-accent)" label="service" square />}
        </div>
        <div className="ml-auto text-xs text-[var(--color-ink-faint)]">
          {topo.nodes.length} node{topo.nodes.length > 1 ? 's' : ''} · {totalPods} pods
          {unhealthy > 0 && (
            <span className="text-[var(--color-crit)]"> · {unhealthy} unhealthy</span>
          )}
          {dense && lens === 'graph' && (
            <button
              className="ml-2 underline decoration-dotted hover:text-[var(--color-accent)]"
              onClick={() => setLens('heatmap')}
            >
              large fleet — try heatmap
            </button>
          )}
        </div>
      </div>
      <Card className="p-4 overflow-auto">
        {lens === 'graph' ? <GraphView topo={topo} /> : <HeatmapView topo={topo} />}
      </Card>
    </div>
  )
}

function LensToggle({ lens, setLens }: { lens: Lens; setLens: (l: Lens) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5 text-xs">
      {(['graph', 'heatmap'] as Lens[]).map((l) => (
        <button
          key={l}
          onClick={() => setLens(l)}
          className={
            'rounded px-3 py-1 capitalize transition ' +
            (lens === l
              ? 'bg-[var(--color-accent)] text-black font-medium'
              : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]')
          }
        >
          {l}
        </button>
      ))}
    </div>
  )
}

function Legend({ color, label, square }: { color: string; label: string; square?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={square ? 'h-3 w-3 rounded-sm' : 'h-3 w-3 rounded-full'}
        style={{ background: color }}
      />
      {label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph lens: services (top) → pods → nodes. Hovering a service highlights the
// pods it selects and dims everything else, so a wiring path pops out.
// ─────────────────────────────────────────────────────────────────────────────
function GraphView({ topo }: { topo: Topo }) {
  const [hoverSvc, setHoverSvc] = useState<string | null>(null)
  const [hoverPod, setHoverPod] = useState<string | null>(null)

  const NODE_W = 240
  const NODE_GAP = 32
  const POD_R = 10
  const POD_GAP = 30
  const PODS_PER_ROW = 5
  const SVC_ROW_Y = 34
  const NODE_TOP = 150

  const layout = useMemo(() => {
    let x = 16
    const podPos = new Map<string, { x: number; y: number; healthy: boolean }>()
    const nodes = topo.nodes.map((n) => {
      const podsTop = NODE_TOP + 62
      const pods = n.pods.map((p, i) => {
        const key = `${p.namespace}/${p.name}`
        const cx = x + 26 + (i % PODS_PER_ROW) * POD_GAP
        const cy = podsTop + Math.floor(i / PODS_PER_ROW) * POD_GAP + POD_R
        podPos.set(key, { x: cx, y: cy, healthy: p.healthy })
        return { ...p, key, cx, cy }
      })
      const rows = Math.ceil(Math.max(n.pods.length, 1) / PODS_PER_ROW)
      const boxH = 44 + rows * POD_GAP + 16
      const box = { x, y: NODE_TOP, w: NODE_W, h: boxH, cx: x + NODE_W / 2 }
      x += NODE_W + NODE_GAP
      return { ...n, box, pods }
    })

    // Services placed evenly across the top row.
    const withPods = topo.services.filter((s) => s.podKeys.some((k) => podPos.has(k)))
    const svcGap = withPods.length > 0 ? Math.max(140, (x - 16) / withPods.length) : 0
    const services = withPods.map((s, i) => ({
      ...s,
      key: `${s.namespace}/${s.name}`,
      cx: 60 + i * svcGap,
      cy: SVC_ROW_Y,
    }))

    const width = Math.max(x, services.length ? 60 + (services.length - 1) * svcGap + 120 : 0)
    const height = Math.max(...nodes.map((n) => n.box.y + n.box.h), 260) + 16
    return { nodes, services, podPos, width, height }
  }, [topo])

  const dimSvc = (k: string) => hoverSvc !== null && hoverSvc !== k
  const podActive = (k: string) => {
    if (hoverPod === k) return true
    if (hoverSvc) {
      const s = layout.services.find((sv) => sv.key === hoverSvc)
      return !!s?.podKeys.includes(k)
    }
    return false
  }
  const anythingHovered = hoverSvc !== null || hoverPod !== null

  return (
    <svg
      width={layout.width}
      height={layout.height}
      className="min-w-full"
      onMouseLeave={() => {
        setHoverSvc(null)
        setHoverPod(null)
      }}
    >
      {/* service → pod edges (drawn first, under everything) */}
      {layout.services.map((s) =>
        s.podKeys.map((k) => {
          const p = layout.podPos.get(k)
          if (!p) return null
          const active = hoverSvc === s.key || hoverPod === k
          return (
            <path
              key={`${s.key}->${k}`}
              d={`M ${s.cx} ${s.cy + 12} C ${s.cx} ${(s.cy + p.y) / 2}, ${p.x} ${(s.cy + p.y) / 2}, ${p.x} ${p.y - 10}`}
              fill="none"
              stroke={active ? 'var(--color-accent)' : 'var(--color-border)'}
              strokeWidth={active ? 2 : 1}
              opacity={anythingHovered && !active ? 0.15 : active ? 0.9 : 0.4}
            />
          )
        }),
      )}

      {/* node boxes */}
      {layout.nodes.map((n) => (
        <g key={n.name}>
          <rect
            x={n.box.x}
            y={n.box.y}
            width={n.box.w}
            height={n.box.h}
            rx={10}
            fill="var(--color-surface)"
            stroke={n.ready ? 'var(--color-info)' : 'var(--color-crit)'}
            strokeWidth={1.5}
            opacity={anythingHovered ? 0.6 : 1}
          />
          <text x={n.box.x + 14} y={n.box.y + 24} fill="var(--color-ink)" fontSize={12} fontWeight={600} className="mono">
            {trim(n.name, 26)}
          </text>
          <text x={n.box.x + 14} y={n.box.y + 40} fill="var(--color-ink-faint)" fontSize={10}>
            {n.pods.length} pods · {n.ready ? 'Ready' : 'NotReady'}
          </text>
        </g>
      ))}

      {/* pods */}
      {layout.nodes.map((n) =>
        n.pods.map((p) => {
          const active = podActive(p.key)
          const dimmed = anythingHovered && !active
          return (
            <circle
              key={p.key}
              cx={p.cx}
              cy={p.cy}
              r={active ? POD_R + 2 : POD_R}
              fill={p.healthy ? 'var(--color-ok)' : 'var(--color-crit)'}
              stroke={active ? 'var(--color-accent)' : 'transparent'}
              strokeWidth={2}
              opacity={dimmed ? 0.2 : 1}
              onMouseEnter={() => setHoverPod(p.key)}
              onMouseLeave={() => setHoverPod(null)}
              style={{ cursor: 'pointer' }}
            >
              <title>
                {p.key} — {p.status}
              </title>
            </circle>
          )
        }),
      )}

      {/* service chips (on top) */}
      {layout.services.map((s) => {
        const dimmed = dimSvc(s.key)
        const w = Math.max(64, s.name.length * 6.5 + 24)
        return (
          <g
            key={s.key}
            onMouseEnter={() => setHoverSvc(s.key)}
            onMouseLeave={() => setHoverSvc(null)}
            style={{ cursor: 'pointer' }}
            opacity={dimmed ? 0.25 : 1}
          >
            <rect
              x={s.cx - w / 2}
              y={s.cy - 12}
              width={w}
              height={24}
              rx={12}
              fill="var(--color-accent-soft)"
              stroke="var(--color-accent)"
              strokeWidth={hoverSvc === s.key ? 1.5 : 1}
            />
            <text x={s.cx} y={s.cy + 4} textAnchor="middle" fill="var(--color-accent)" fontSize={11} fontWeight={600}>
              {trim(s.name, 18)}
            </text>
            <text x={s.cx} y={s.cy + 24} textAnchor="middle" fill="var(--color-ink-faint)" fontSize={9}>
              {s.type} · {s.podKeys.length}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Heatmap lens: one tile per node, one cell per pod. Cell size shrinks as pod
// count grows, so a 500-pod node still fits. Color = health; the tooltip carries
// the identity so we never need labels on the cells themselves.
// ─────────────────────────────────────────────────────────────────────────────
function HeatmapView({ topo }: { topo: Topo }) {
  const maxPods = Math.max(...topo.nodes.map((n) => n.pods.length), 1)
  // Cells per row scale with the busiest node so all tiles share a grid rhythm.
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
            style={{
              borderColor: n.ready ? 'var(--color-border)' : 'var(--color-crit)',
              background: 'var(--color-surface)',
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-6">
              <span className="mono text-xs font-semibold text-[var(--color-ink)]">
                {trim(n.name, 28)}
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
                  width={cell}
                  height={cell}
                  rx={2}
                  fill={p.healthy ? 'var(--color-ok)' : 'var(--color-crit)'}
                  opacity={p.healthy ? 0.85 : 1}
                >
                  <title>
                    {p.namespace}/{p.name} — {p.status}
                  </title>
                </rect>
              ))}
            </svg>
          </div>
        )
      })}
    </div>
  )
}

function trim(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}
