import { useMemo, useState } from 'react'
import type { Topology } from '../../api'
import { flatten, workloads, nsColor, kindGlyph } from './shared'

// Variant 2 — Workload graph. Nodes are workloads (Deployment/StatefulSet/…),
// sized by replica count and colored by health; a workload links to every
// service that selects it. We do NOT invent app-level call graphs (Kubernetes
// doesn't know web→api→db) — every edge shown is a real selector relationship.
// Layout is a deterministic force simulation (no RNG, seeded by index) so it's
// stable across reloads and safe in the workflow sandbox.
export function DependencyGraph({ topo }: { topo: Topology }) {
  const [hover, setHover] = useState<string | null>(null)

  const sim = useMemo(() => {
    const pods = flatten(topo)
    const wl = workloads(pods)
    // service nodes that actually front something
    const svcNodes = topo.services
      .filter((s) => s.podKeys.length > 0)
      .map((s) => ({ id: `svc/${s.namespace}/${s.name}`, kind: 'Service', label: s.name, namespace: s.namespace, size: 1, healthy: 1, total: 1 }))
    const wlNodes = wl.map((w) => ({
      id: `wl/${w.key}`, kind: w.kind, label: w.name, namespace: w.namespace,
      size: w.total, healthy: w.healthy, total: w.total,
    }))
    const nodes = [...wlNodes, ...svcNodes]

    // edges: service -> workload it selects
    const idOfWorkloadPod = new Map<string, string>() // podKey -> workload id
    for (const w of wl) for (const p of w.pods) idOfWorkloadPod.set(p.key, `wl/${w.key}`)
    const edges: { a: string; b: string }[] = []
    for (const s of topo.services) {
      const sid = `svc/${s.namespace}/${s.name}`
      const targets = new Set<string>()
      for (const k of s.podKeys) { const wid = idOfWorkloadPod.get(k); if (wid) targets.add(wid) }
      for (const t of targets) edges.push({ a: sid, b: t })
    }

    // --- deterministic layout: seed on a circle by index, then relax with a few
    // fixed force iterations (repulsion + spring on edges). No randomness. ---
    const N = nodes.length
    const W = 1200, H = 720, cx = W / 2, cy = H / 2
    const pos = new Map<string, { x: number; y: number }>()
    nodes.forEach((n, i) => {
      const a = (i / Math.max(N, 1)) * Math.PI * 2
      const r = 130 + (i % 7) * 34 // rings to avoid perfect overlap
      pos.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
    })
    const idx = new Map(nodes.map((n, i) => [n.id, i]))
    for (let iter = 0; iter < 220; iter++) {
      const disp = nodes.map(() => ({ x: 0, y: 0 }))
      // repulsion between all pairs
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const pi = pos.get(nodes[i].id)!, pj = pos.get(nodes[j].id)!
          let dx = pi.x - pj.x, dy = pi.y - pj.y
          let d2 = dx * dx + dy * dy || 0.01
          const f = 4200 / d2
          const d = Math.sqrt(d2)
          dx /= d; dy /= d
          disp[i].x += dx * f; disp[i].y += dy * f
          disp[j].x -= dx * f; disp[j].y -= dy * f
        }
      }
      // springs along edges
      for (const e of edges) {
        const ia = idx.get(e.a)!, ib = idx.get(e.b)!
        const pa = pos.get(e.a)!, pb = pos.get(e.b)!
        let dx = pb.x - pa.x, dy = pb.y - pa.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - 120) * 0.02
        dx /= d; dy /= d
        disp[ia].x += dx * f; disp[ia].y += dy * f
        disp[ib].x -= dx * f; disp[ib].y -= dy * f
      }
      // gentle pull to center + integrate
      const cool = 1 - iter / 260
      nodes.forEach((n, i) => {
        const p = pos.get(n.id)!
        p.x += (disp[i].x + (cx - p.x) * 0.008) * cool
        p.y += (disp[i].y + (cy - p.y) * 0.008) * cool
        p.x = Math.max(40, Math.min(W - 40, p.x))
        p.y = Math.max(40, Math.min(H - 40, p.y))
      })
    }
    return { nodes, edges, pos, W, H }
  }, [topo])

  const neighbors = (id: string) =>
    new Set(sim.edges.filter((e) => e.a === id || e.b === id).flatMap((e) => [e.a, e.b]))
  const hi = hover ? neighbors(hover) : null

  return (
    <svg viewBox={`0 0 ${sim.W} ${sim.H}`} className="w-full" style={{ maxHeight: '78vh' }}
      onMouseLeave={() => setHover(null)}>
      {sim.edges.map((e, i) => {
        const a = sim.pos.get(e.a)!, b = sim.pos.get(e.b)!
        const on = hover && (e.a === hover || e.b === hover)
        return (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={on ? 'var(--color-accent)' : 'var(--color-border)'}
            strokeWidth={on ? 2 : 1}
            opacity={hover ? (on ? 0.9 : 0.08) : 0.35} />
        )
      })}
      {sim.nodes.map((n) => {
        const p = sim.pos.get(n.id)!
        const isSvc = n.kind === 'Service'
        const r = isSvc ? 7 : 10 + Math.min(n.size, 8) * 1.4
        const dim = hi && !hi.has(n.id) && n.id !== hover
        const bad = n.total - n.healthy
        const fill = isSvc ? 'var(--color-accent)' : bad > 0 ? 'var(--color-crit)' : 'var(--color-ok)'
        return (
          <g key={n.id} opacity={dim ? 0.2 : 1}
            onMouseEnter={() => setHover(n.id)} style={{ cursor: 'pointer' }}>
            {isSvc ? (
              <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={3}
                fill="none" stroke={fill} strokeWidth={2} />
            ) : (
              <circle cx={p.x} cy={p.y} r={r} fill={fill}
                stroke={nsColor(n.namespace)} strokeWidth={2} />
            )}
            {(hover === n.id || !hover) && (
              <text x={p.x} y={p.y - r - 4} textAnchor="middle"
                fontSize={11} fill="var(--color-ink)" className="mono">
                {isSvc ? '' : kindGlyph(n.kind) + ' '}{n.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
