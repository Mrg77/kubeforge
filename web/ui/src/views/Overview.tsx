import { useEffect, useState } from 'react'
import { api, type Pod, type Node, type FinReport, type SecReport, type StorageReport } from '../api'
import { Card, Stat, StatusBadge, Spinner, ErrorNote } from '../lib'

// Overview: the "how is my cluster doing?" landing hub. A pillar summary row up
// top gives the headline for each area (cost, security, storage) and links into
// it; below, cluster health with unhealthy pods surfaced first.
export function Overview() {
  const [pods, setPods] = useState<Pod[] | null>(null)
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [fin, setFin] = useState<FinReport | null>(null)
  const [sec, setSec] = useState<SecReport | null>(null)
  const [sto, setSto] = useState<StorageReport | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.pods().then(setPods).catch((e) => setErr(String(e.message ?? e)))
    api.nodes().then(setNodes).catch(() => {})
    // pillar headlines — best-effort, they enrich the hub but never block it
    api.finops().then(setFin).catch(() => {})
    api.secops().then(setSec).catch(() => {})
    api.storage().then(setSto).catch(() => {})
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!pods) return <Spinner />

  const unhealthy = pods.filter((p) => !p.healthy)
  const nodesReady = nodes?.filter((n) => n.ready).length ?? 0

  return (
    <div className="flex flex-col gap-6">
      {/* Pillar hub — headline per area, click to dive in */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <PillarCard tab="finops" title="FinOps" accent="var(--color-warn)"
          value={fin ? `$${Math.round(fin.wastedMonthly)}/mo` : '…'}
          sub={fin ? 'estimated waste' : 'loading'} />
        <PillarCard tab="secops" title="SecOps" accent="var(--color-crit)"
          value={sec ? `${sec.counts.critical + sec.counts.high}` : '…'}
          sub={sec ? 'critical + high findings' : 'loading'} />
        <PillarCard tab="storage" title="Storage" accent="var(--color-info)"
          value={sto ? `${sto.totalCapacityGB} GB` : '…'}
          sub={sto ? `${sto.orphanedCapacityGB} GB orphaned` : 'loading'} />
        <PillarCard tab="topology" title="Topology" accent="var(--color-accent)"
          value={nodes ? `${nodes.length} nodes` : '…'}
          sub="explore the resource stack" />
      </div>

      {/* Health stats row */}
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

// PillarCard is a clickable hub tile linking to a pillar's tab. It navigates by
// setting ?tab= and reloading — the app reads the tab from the URL on load.
function PillarCard({ tab, title, value, sub, accent }: {
  tab: string; title: string; value: string; sub: string; accent: string
}) {
  const go = () => {
    const u = new URL(location.href)
    u.searchParams.set('tab', tab)
    location.assign(u.toString())
  }
  return (
    <button onClick={go}
      className="group rounded-xl border p-4 text-left transition hover:border-[color:var(--accent)]"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', ['--accent' as string]: accent }}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide" style={{ color: accent }}>{title}</span>
        <span className="text-[var(--color-ink-faint)] transition group-hover:translate-x-0.5">→</span>
      </div>
      <div className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">{value}</div>
      <div className="mt-0.5 text-xs text-[var(--color-ink-dim)]">{sub}</div>
    </button>
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
