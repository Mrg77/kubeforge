import { useEffect, useMemo, useState } from 'react'
import { api, type LayeredGraph, type GraphNode, type EventLine } from '../../api'
import { Spinner, ErrorNote } from '../../lib'

// Layered — the resource stack of a namespace, drawn top (high-level: traffic in)
// to bottom (low-level: config, identity, storage). Every node is a real object
// and every edge a real reference read from a spec (a Service selects Pods, a Pod
// mounts a Secret, runs as a ServiceAccount bound to a Role, a PVC binds a PV…).
// This is the picture list-based tools (k9s, Lens) can't draw: how everything in
// a namespace actually fits together.

// Color + glyph per kind, so each layer reads at a glance.
const KIND: Record<string, { c: string; icon: string }> = {
  Ingress: { c: '#58a6ff', icon: '🌐' },
  Service: { c: '#f0883e', icon: '🔌' },
  Deployment: { c: '#3fb950', icon: '⧉' },
  StatefulSet: { c: '#3fb950', icon: '⛃' },
  DaemonSet: { c: '#3fb950', icon: '⬡' },
  Job: { c: '#3fb950', icon: '⧗' },
  ReplicaSet: { c: '#6b7683', icon: '❏' },
  Pod: { c: '#3fb950', icon: '●' },
  ConfigMap: { c: '#d29922', icon: '⚙' },
  Secret: { c: '#f85149', icon: '🔑' },
  ServiceAccount: { c: '#a371f7', icon: '👤' },
  RoleBinding: { c: '#a371f7', icon: '🔗' },
  Role: { c: '#a371f7', icon: '📜' },
  ClusterRole: { c: '#a371f7', icon: '📜' },
  PersistentVolumeClaim: { c: '#39c5cf', icon: '💾' },
  PersistentVolume: { c: '#39c5cf', icon: '🗄' },
  StorageClass: { c: '#39c5cf', icon: '🏷' },
  NetworkPolicy: { c: '#db61a2', icon: '🛡' },
  ResourceQuota: { c: '#db61a2', icon: '📊' },
  LimitRange: { c: '#db61a2', icon: '📐' },
  CronJob: { c: '#3fb950', icon: '⏰' },
  HorizontalPodAutoscaler: { c: '#db61a2', icon: '📈' },
  PodDisruptionBudget: { c: '#db61a2', icon: '🚧' },
}
const kindOf = (k: string) => KIND[k] ?? { c: '#9aa7b4', icon: '◻' }

const CHIP_W = 150
const CHIP_H = 34
const CHIP_GAP_X = 14
const LAYER_LABEL_W = 128
const ROW_H = 78
const PAD = 24

export function Layered() {
  const [nsList, setNsList] = useState<string[] | null>(null)
  const [ns, setNs] = useState<string | null>(null)
  const [graph, setGraph] = useState<LayeredGraph | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)

  useEffect(() => {
    api.namespaces().then((all) => {
      // honor a deep-link ?ns=… (e.g. from a SecOps "view in stack" link),
      // else prefer an interesting workload namespace as the default.
      const wanted = new URLSearchParams(location.search).get('ns')
      const skip = new Set(['kube-system', 'kube-public', 'kube-node-lease'])
      const pref =
        (wanted && all.includes(wanted) ? wanted : undefined) ??
        all.find((n) => n === 'shop') ??
        all.find((n) => !skip.has(n)) ??
        all[0]
      setNsList(all)
      setNs(pref)
    }).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    if (!ns) return
    setGraph(null)
    api.layers(ns).then(setGraph).catch((e) => setErr(String(e.message ?? e)))
  }, [ns])

  if (err) return <ErrorNote message={err} />

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--color-ink-dim)]">namespace</span>
        <select
          value={ns ?? ''}
          onChange={(e) => setNs(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs mono outline-none"
        >
          {nsList?.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="ml-2 text-[11px] text-[var(--color-ink-faint)]">
          traffic in at the top · config, identity &amp; storage at the bottom
        </span>
      </div>

      {!graph ? (
        <Spinner />
      ) : graph.nodes.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center text-sm text-[var(--color-ink-dim)]">
          Nothing to show — <span className="mono">{graph.namespace}</span> has no workloads or
          resources yet.
        </div>
      ) : (
        <Stack graph={graph} hover={hover} setHover={setHover} onSelect={setSelected} />
      )}

      {selected && ns && (
        <ObjectDrawer node={selected} namespace={ns} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function Stack({ graph, hover, setHover, onSelect }: {
  graph: LayeredGraph
  hover: string | null
  setHover: (s: string | null) => void
  onSelect: (n: GraphNode) => void
}) {
  const layout = useMemo(() => {
    // keep only layers that actually have nodes, in the backend's order
    const present = graph.layers.filter((l) => graph.nodes.some((n) => n.layer === l.id))
    const byLayer = new Map<string, GraphNode[]>()
    for (const l of present) byLayer.set(l.id, [])
    for (const n of graph.nodes) byLayer.get(n.layer)?.push(n)

    // order nodes within each layer by name for stability
    for (const arr of byLayer.values()) arr.sort((a, b) => a.name.localeCompare(b.name))

    // position: each present layer is a row; nodes spread across the row
    const pos = new Map<string, { x: number; y: number }>()
    let maxCols = 0
    present.forEach((l, row) => {
      const arr = byLayer.get(l.id)!
      maxCols = Math.max(maxCols, arr.length)
      arr.forEach((n, i) => {
        pos.set(n.id, {
          x: LAYER_LABEL_W + PAD + i * (CHIP_W + CHIP_GAP_X),
          y: PAD + row * ROW_H,
        })
      })
    })
    const width = LAYER_LABEL_W + PAD * 2 + maxCols * (CHIP_W + CHIP_GAP_X)
    const height = PAD * 2 + present.length * ROW_H
    return { present, byLayer, pos, width: Math.max(width, 720), height }
  }, [graph])

  // adjacency for hover highlight (both directions)
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of graph.edges) {
      ;(m.get(e.from) ?? m.set(e.from, new Set()).get(e.from)!).add(e.to)
      ;(m.get(e.to) ?? m.set(e.to, new Set()).get(e.to)!).add(e.from)
    }
    return m
  }, [graph])
  const lit = hover ? new Set([hover, ...(adj.get(hover) ?? [])]) : null
  const hoveredNode = hover ? graph.nodes.find((n) => n.id === hover) : null

  return (
    <div className="relative overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      {hoveredNode && (hoveredNode.info?.length ?? 0) > 0 && (
        <DetailPanel node={hoveredNode} />
      )}
      <svg width={layout.width} height={layout.height} style={{ minWidth: '100%' }}>
        <defs>
          <marker id="arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-ink-faint)" />
          </marker>
          <marker id="arrow-on" markerWidth="8" markerHeight="8" refX="6" refY="3.2" orient="auto">
            <path d="M0,0 L6.5,3.2 L0,6.4 Z" fill="var(--color-accent)" />
          </marker>
        </defs>
        {/* layer bands + labels */}
        {layout.present.map((l, row) => {
          const y = PAD + row * ROW_H
          return (
            <g key={l.id}>
              <rect x={0} y={y - 12} width={layout.width} height={ROW_H - 8} rx={6}
                fill={row % 2 ? 'transparent' : 'var(--color-bg)'} opacity={0.5} />
              <text x={12} y={y + CHIP_H / 2} fill="var(--color-ink-faint)" fontSize={11}
                className="mono" dominantBaseline="middle">{l.label}</text>
            </g>
          )
        })}

        {/* edges */}
        {graph.edges.map((e, i) => {
          const a = layout.pos.get(e.from), b = layout.pos.get(e.to)
          if (!a || !b) return null
          const x1 = a.x + CHIP_W / 2, y1 = a.y + CHIP_H
          const x2 = b.x + CHIP_W / 2, y2 = b.y
          const on = lit && (e.from === hover || e.to === hover)
          // stop a touch above the target chip so the arrowhead sits clear of it
          const ty = y2 - 3
          const my = (y1 + ty) / 2
          return (
            <path key={i}
              d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${ty}`}
              fill="none"
              stroke={on ? 'var(--color-accent)' : 'var(--color-ink-faint)'}
              strokeWidth={on ? 2 : 1.2}
              markerEnd={on ? 'url(#arrow-on)' : 'url(#arrow)'}
              opacity={lit ? (on ? 0.95 : 0.05) : 0.55} />
          )
        })}

        {/* nodes */}
        {graph.nodes.map((n) => {
          const p = layout.pos.get(n.id)
          if (!p) return null
          const meta = kindOf(n.kind)
          const dim = lit && !lit.has(n.id)
          const bad = !n.healthy
          const risky = (n.risk?.length ?? 0) > 0
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(n)}
              style={{ cursor: 'pointer' }} opacity={dim ? 0.2 : 1}>
              <rect width={CHIP_W} height={CHIP_H} rx={7}
                fill="var(--color-surface-2)"
                stroke={bad ? 'var(--color-crit)' : risky ? 'var(--color-warn)' : meta.c}
                strokeWidth={n.id === hover ? 2 : 1.2} />
              <text x={9} y={CHIP_H / 2} fontSize={13} dominantBaseline="middle">{meta.icon}</text>
              <text x={26} y={12} fontSize={10.5} fill="var(--color-ink)" className="mono">
                {clip(n.name, risky || n.custom ? 12 : 15)}
              </text>
              <text x={26} y={25} fontSize={8.5} fill="var(--color-ink-faint)">
                {n.detail || n.kind}
              </text>
              {/* SecOps risk pill */}
              {risky && (
                <g transform={`translate(${CHIP_W - 18},6)`}>
                  <circle r={6} fill="var(--color-warn)" />
                  <text x={0} y={0.5} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight={700} fill="#000">!</text>
                  <title>{n.risk!.join(', ')}</title>
                </g>
              )}
              {/* custom (CRD) badge */}
              {n.custom && !risky && (
                <g transform={`translate(${CHIP_W - 22},7)`}>
                  <rect width={16} height={11} rx={3} fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeWidth={0.6} />
                  <text x={8} y={6} textAnchor="middle" dominantBaseline="middle" fontSize={6.5} fill="var(--color-accent)">CRD</text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// DetailPanel floats in the top-right corner and shows the hovered resource's
// facts (IP, node, ports, capacity, estimated monthly cost…). Pinned to the
// container so it never scrolls off with a wide graph.
function DetailPanel({ node }: { node: GraphNode }) {
  const meta = kindOf(node.kind)
  return (
    <div className="pointer-events-none fixed right-6 top-28 z-30 w-64 rounded-lg border bg-[var(--color-bg)] p-3 shadow-2xl"
      style={{ borderColor: meta.c }}>
      <div className="mb-2 flex items-center gap-2">
        <span>{meta.icon}</span>
        <span className="mono text-xs font-semibold text-[var(--color-ink)]">{node.name}</span>
      </div>
      <div className="mb-2 text-[10px] uppercase tracking-wide" style={{ color: meta.c }}>{node.kind}</div>
      <div className="flex flex-col gap-1">
        {node.info!.map((row) => (
          <div key={row.k} className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="text-[var(--color-ink-faint)]">{row.k}</span>
            <span className="mono text-right text-[var(--color-ink)]">{row.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ObjectDrawer slides in when a node is clicked: it shows the resource's facts,
// any SecOps risks, its recent events (the quick "why unhealthy"), and the live
// manifest (Secret data redacted server-side).
function ObjectDrawer({ node, namespace, onClose }: {
  node: GraphNode
  namespace: string
  onClose: () => void
}) {
  const meta = kindOf(node.kind)
  const [tab, setTab] = useState<'detail' | 'events' | 'yaml'>('detail')
  const [yaml, setYaml] = useState<string | null>(null)
  const [events, setEvents] = useState<EventLine[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadYAML = () => {
    if (yaml !== null) return
    setBusy(true)
    api.objectYAML(node.kind, namespace, node.name)
      .then((r) => setYaml(r.yaml))
      .catch((e) => setYaml('⚠ ' + String(e.message ?? e)))
      .finally(() => setBusy(false))
  }
  const loadEvents = () => {
    if (events !== null) return
    setBusy(true)
    api.objectEvents(namespace, node.name)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <span>{meta.icon}</span>
          <span className="mono text-sm font-semibold text-[var(--color-ink)]">{node.name}</span>
          <span className="rounded px-1.5 text-[10px]" style={{ color: meta.c, background: 'var(--color-bg)' }}>
            {node.kind}{node.custom ? ' · CRD' : ''}
          </span>
          <button onClick={onClose} className="ml-auto text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">✕</button>
        </header>

        <div className="flex gap-1 border-b border-[var(--color-border)] px-3 py-2 text-xs">
          {(['detail', 'events', 'yaml'] as const).map((t) => (
            <button key={t}
              onClick={() => { setTab(t); if (t === 'yaml') loadYAML(); if (t === 'events') loadEvents() }}
              className={'rounded px-3 py-1 capitalize ' + (tab === t
                ? 'bg-[var(--color-accent)] text-black font-medium'
                : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]')}>
              {t === 'yaml' ? 'manifest' : t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-5">
          {tab === 'detail' && (
            <div className="flex flex-col gap-4">
              {(node.risk?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-bg)] p-3">
                  <div className="mb-1 text-xs font-medium text-[var(--color-warn)]">⚠ SecOps warnings</div>
                  <div className="flex flex-wrap gap-1.5">
                    {node.risk!.map((r) => (
                      <span key={r} className="mono rounded bg-[var(--color-warn)] px-1.5 py-0.5 text-[10px] text-black">{r}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {(node.info ?? []).map((row) => (
                  <div key={row.k} className="flex items-baseline justify-between gap-4 text-xs">
                    <span className="text-[var(--color-ink-faint)]">{row.k}</span>
                    <span className="mono text-right text-[var(--color-ink)]">{row.v}</span>
                  </div>
                ))}
                {(node.info?.length ?? 0) === 0 && (
                  <span className="text-xs text-[var(--color-ink-faint)]">No extra detail for this kind.</span>
                )}
              </div>
            </div>
          )}

          {tab === 'events' && (
            busy && !events ? <Spinner /> :
            (events?.length ?? 0) === 0 ? (
              <div className="text-xs text-[var(--color-ink-faint)]">No recent events for this object.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {events!.map((e, i) => (
                  <div key={i} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={e.type === 'Warning' ? 'text-[var(--color-crit)]' : 'text-[var(--color-ok)]'}>●</span>
                      <span className="font-medium text-[var(--color-ink)]">{e.reason}</span>
                      <span className="ml-auto text-[10px] text-[var(--color-ink-faint)]">×{e.count} · {e.age}</span>
                    </div>
                    <div className="mt-1 text-[var(--color-ink-dim)]">{e.message}</div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'yaml' && (
            busy && yaml === null ? <Spinner /> : (
              <pre className="overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[11px] leading-relaxed text-[var(--color-ink)]">
                {yaml}
              </pre>
            )
          )}
        </div>
      </aside>
    </>
  )
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}
