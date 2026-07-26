import { useEffect, useState } from 'react'
import { api, type Pod, type Node } from '../api'
import { Card, Stat, StatusBadge, Spinner, ErrorNote } from '../lib'

// Overview: the "how is my cluster doing?" landing view. Health first —
// unhealthy pods surface at the top, with the counts that matter at a glance.
export function Overview() {
  const [pods, setPods] = useState<Pod[] | null>(null)
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.pods().then(setPods).catch((e) => setErr(String(e.message ?? e)))
    api.nodes().then(setNodes).catch(() => {})
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!pods) return <Spinner />

  const unhealthy = pods.filter((p) => !p.healthy)
  const nodesReady = nodes?.filter((n) => n.ready).length ?? 0

  return (
    <div className="flex flex-col gap-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Pods" value={pods.length} hint={`${pods.length - unhealthy.length} healthy`} />
        <Stat
          label="Unhealthy"
          value={unhealthy.length}
          tone={unhealthy.length ? 'crit' : 'ok'}
          hint={unhealthy.length ? 'need attention' : 'all good'}
        />
        <Stat label="Nodes" value={nodes ? `${nodesReady}/${nodes.length}` : '…'} hint="ready" />
        <Stat
          label="Restarts"
          value={pods.reduce((s, p) => s + p.restarts, 0)}
          tone={pods.some((p) => p.restarts > 5) ? 'warn' : 'ink'}
          hint="across all pods"
        />
      </div>

      {/* Unhealthy pods, called out */}
      {unhealthy.length > 0 && (
        <Card>
          <div className="border-b border-[var(--color-border)] px-5 py-3 text-sm font-medium">
            Needs attention
          </div>
          <PodTable pods={unhealthy} />
        </Card>
      )}

      {/* All pods */}
      <Card>
        <div className="border-b border-[var(--color-border)] px-5 py-3 text-sm font-medium">
          All pods <span className="text-[var(--color-ink-faint)]">({pods.length})</span>
        </div>
        <PodTable pods={pods} />
      </Card>
    </div>
  )
}

function PodTable({ pods }: { pods: Pod[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
            <th className="px-5 py-2 font-medium">Namespace</th>
            <th className="px-5 py-2 font-medium">Pod</th>
            <th className="px-5 py-2 font-medium">Status</th>
            <th className="px-5 py-2 font-medium">Ready</th>
            <th className="px-5 py-2 font-medium">Restarts</th>
            <th className="px-5 py-2 font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr
              key={`${p.namespace}/${p.name}`}
              className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              <td className="px-5 py-2 text-[var(--color-ink-dim)] mono">{p.namespace}</td>
              <td className="px-5 py-2 mono">{p.name}</td>
              <td className="px-5 py-2">
                <StatusBadge status={p.status} healthy={p.healthy} />
              </td>
              <td className="px-5 py-2 mono">{p.ready}</td>
              <td className="px-5 py-2 mono" style={p.restarts > 5 ? { color: 'var(--color-warn)' } : undefined}>
                {p.restarts}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-dim)] mono">{p.age}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
