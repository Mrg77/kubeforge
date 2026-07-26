import type { Topology, TopoPod } from '../../api'

// Shared helpers for the topology layout variants. Each variant is a different
// way to draw the SAME graph; these functions reshape the raw /api/topology
// payload into whatever grouping a variant needs.

export interface FlatPod extends TopoPod {
  key: string // namespace/name
  node: string
}

// Flatten the node-grouped payload into a single pod list, remembering each
// pod's node. This is the starting point for the namespace and dependency views.
export function flatten(topo: Topology): FlatPod[] {
  const out: FlatPod[] = []
  for (const n of topo.nodes) {
    for (const p of n.pods) {
      out.push({ ...p, key: `${p.namespace}/${p.name}`, node: n.name })
    }
  }
  return out
}

export interface Workload {
  key: string // namespace/owner
  name: string // owner
  namespace: string
  kind: string
  pods: FlatPod[]
  healthy: number
  total: number
}

// Group pods by their owning workload (Deployment/StatefulSet/…), within a
// namespace. A workload is the unit a human reasons about ("the web deployment"),
// not the individual replica.
export function workloads(pods: FlatPod[]): Workload[] {
  const by = new Map<string, Workload>()
  for (const p of pods) {
    const key = `${p.namespace}/${p.owner}`
    let w = by.get(key)
    if (!w) {
      w = { key, name: p.owner, namespace: p.namespace, kind: p.ownerKind, pods: [], healthy: 0, total: 0 }
      by.set(key, w)
    }
    w.pods.push(p)
    w.total++
    if (p.healthy) w.healthy++
  }
  return [...by.values()]
}

// Group anything with a `namespace` field by namespace, ordered with the busiest
// (most pods) first so the eye lands on the biggest blocks.
export function byNamespace<T extends { namespace: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const arr = m.get(it.namespace) ?? []
    arr.push(it)
    m.set(it.namespace, arr)
  }
  return m
}

// A stable, pleasant color per namespace (derived from the name so it's
// deterministic across renders and reloads). Health still overrides via the
// pod dot color; this tints the container, not the status.
export function nsColor(ns: string): string {
  let h = 0
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) % 360
  return `hsl(${h} 45% 55%)`
}

export const OK = 'var(--color-ok)'
export const CRIT = 'var(--color-crit)'
export const podColor = (p: { healthy: boolean }) => (p.healthy ? OK : CRIT)

// Short kind glyph for compact labels.
export function kindGlyph(kind: string): string {
  switch (kind) {
    case 'Deployment': return '⧉'
    case 'StatefulSet': return '⛃'
    case 'DaemonSet': return '⬡'
    case 'Job': return '⧗'
    default: return '◻'
  }
}
