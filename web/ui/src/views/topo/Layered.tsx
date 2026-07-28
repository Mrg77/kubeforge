import { useEffect, useMemo, useState } from 'react'
import { api, type LayeredGraph, type GraphNode, type EventLine } from '../../api'
import { Spinner, ErrorNote } from '../../lib'
import { useT } from '../../i18n'

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
  const { t } = useT()
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
        <span className="text-xs text-[var(--color-ink-dim)]">{t('topo.namespace')}</span>
        <select
          value={ns ?? ''}
          onChange={(e) => setNs(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs mono outline-none"
        >
          {nsList?.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="ml-2 text-[11px] text-[var(--color-ink-faint)]">
          {t('topo.stackHint')}
        </span>
      </div>

      {!graph ? (
        <Spinner />
      ) : graph.nodes.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center text-sm text-[var(--color-ink-dim)]">
          {t('topo.empty', { ns: graph.namespace })}
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

// LAYER_CAP is how many chips a layer shows before collapsing to a "+N more".
// Keeps a 100-pod namespace readable; problems (unhealthy/risky) sort to the
// front so they're always visible even when collapsed.
const LAYER_CAP = 12

function Stack({ graph, hover, setHover, onSelect }: {
  graph: LayeredGraph
  hover: string | null
  setHover: (s: string | null) => void
  onSelect: (n: GraphNode) => void
}) {
  const { t } = useT()
  const layerLabel = (id: string, fallback: string) => {
    const k = `topo.layer.${id}`
    const v = t(k)
    return v === k ? fallback : v
  }
  const layerLabelT = (which: 'more' | 'less') => t(which === 'more' ? 'topo.more' : 'topo.less')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleLayer = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const layout = useMemo(() => {
    // keep only layers that actually have nodes, in the backend's order
    const present = graph.layers.filter((l) => graph.nodes.some((n) => n.layer === l.id))
    const byLayer = new Map<string, GraphNode[]>()
    for (const l of present) byLayer.set(l.id, [])
    for (const n of graph.nodes) byLayer.get(n.layer)?.push(n)

    // sort each layer: problems first (unhealthy, then risky), then by name — so
    // a capped layer still surfaces what needs attention.
    const rank = (n: GraphNode) => (!n.healthy ? 0 : (n.risk?.length ?? 0) > 0 ? 1 : 2)
    for (const arr of byLayer.values())
      arr.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

    // position: each present layer is a row; visible nodes spread across it.
    const pos = new Map<string, { x: number; y: number }>()
    const overflow = new Map<string, number>() // layer id -> hidden count
    let maxCols = 0
    present.forEach((l, row) => {
      const arr = byLayer.get(l.id)!
      const isOpen = expanded.has(l.id)
      const visible = isOpen ? arr : arr.slice(0, LAYER_CAP)
      const hidden = arr.length - visible.length
      if (hidden > 0 || (isOpen && arr.length > LAYER_CAP)) overflow.set(l.id, hidden)
      // +1 column slot reserved for the "+N more" / "show less" chip when capped
      const cols = visible.length + (arr.length > LAYER_CAP ? 1 : 0)
      maxCols = Math.max(maxCols, cols)
      visible.forEach((n, i) => {
        pos.set(n.id, {
          x: LAYER_LABEL_W + PAD + i * (CHIP_W + CHIP_GAP_X),
          y: PAD + row * ROW_H,
        })
      })
    })
    const width = LAYER_LABEL_W + PAD * 2 + maxCols * (CHIP_W + CHIP_GAP_X)
    const height = PAD * 2 + present.length * ROW_H
    return { present, byLayer, pos, overflow, width: Math.max(width, 720), height }
  }, [graph, expanded])

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
        {/* layer bands + labels + overflow chips */}
        {layout.present.map((l, row) => {
          const y = PAD + row * ROW_H
          const arr = layout.byLayer.get(l.id)!
          const capped = arr.length > LAYER_CAP
          const isOpen = expanded.has(l.id)
          const hidden = layout.overflow.get(l.id) ?? 0
          // x-slot for the overflow chip = after the last visible chip
          const shown = isOpen ? arr.length : Math.min(arr.length, LAYER_CAP)
          const chipX = LAYER_LABEL_W + PAD + shown * (CHIP_W + CHIP_GAP_X)
          return (
            <g key={l.id}>
              <rect x={0} y={y - 12} width={layout.width} height={ROW_H - 8} rx={6}
                fill={row % 2 ? 'transparent' : 'var(--color-bg)'} opacity={0.5} />
              <text x={12} y={y + CHIP_H / 2} fill="var(--color-ink-faint)" fontSize={11}
                className="mono" dominantBaseline="middle">{layerLabel(l.id, l.label)}</text>
              {capped && (
                <g transform={`translate(${chipX},${y})`} onClick={() => toggleLayer(l.id)} style={{ cursor: 'pointer' }}>
                  <rect width={CHIP_W} height={CHIP_H} rx={7}
                    fill="var(--color-surface-2)" stroke="var(--color-border)" strokeDasharray="3 3" />
                  <text x={CHIP_W / 2} y={CHIP_H / 2} textAnchor="middle" dominantBaseline="middle"
                    fontSize={11} fill="var(--color-accent)">
                    {isOpen ? layerLabelT('less') : `+${hidden} ${layerLabelT('more')}`}
                  </text>
                </g>
              )}
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
export function ObjectDrawer({ node, namespace, onClose }: {
  node: GraphNode
  namespace: string
  onClose: () => void
}) {
  const { t } = useT()
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
          {(['detail', 'events', 'yaml'] as const).map((tabId) => (
            <button key={tabId}
              onClick={() => { setTab(tabId); if (tabId === 'yaml') loadYAML(); if (tabId === 'events') loadEvents() }}
              className={'rounded px-3 py-1 ' + (tab === tabId
                ? 'bg-[var(--color-accent)] text-black font-medium'
                : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]')}>
              {tabId === 'yaml' ? t('topo.tab.manifest') : tabId === 'events' ? t('topo.tab.events') : t('topo.tab.detail')}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-5">
          {tab === 'detail' && (
            <div className="flex flex-col gap-4">
              {(node.risk?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-bg)] p-3">
                  <div className="mb-1 text-xs font-medium text-[var(--color-warn)]">⚠ {t('topo.secWarnings')}</div>
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
                  <span className="text-xs text-[var(--color-ink-faint)]">{t('topo.noDetail')}</span>
                )}
              </div>
            </div>
          )}

          {tab === 'events' && (
            busy && !events ? <Spinner /> :
            (events?.length ?? 0) === 0 ? (
              <div className="text-xs text-[var(--color-ink-faint)]">{t('topo.noEvents')}</div>
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
