import { useEffect, useState } from 'react'
import { api, type Pod, type Node, type FinReport, type SecReport, type StorageReport } from '../api'
import { Card, Stat, StatusBadge, Spinner, ErrorNote } from '../lib'
import { useT } from '../i18n'

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
  const { t } = useT()

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
        <PillarCard tab="finops" title={t('ov.finops')} accent="var(--color-warn)"
          value={fin ? `$${Math.round(fin.wastedMonthly)}/mo` : '…'}
          sub={fin ? t('ov.finops.sub') : t('common.loading')} />
        <PillarCard tab="secops" title={t('ov.secops')} accent="var(--color-crit)"
          value={sec ? `${sec.counts.critical + sec.counts.high}` : '…'}
          sub={sec ? t('ov.secops.sub') : t('common.loading')} />
        <PillarCard tab="storage" title={t('ov.storage')} accent="var(--color-info)"
          value={sto ? `${sto.totalCapacityGB} GB` : '…'}
          sub={sto ? t('ov.storage.sub', { n: sto.orphanedCapacityGB }) : t('common.loading')} />
        <PillarCard tab="topology" title={t('ov.topology')} accent="var(--color-accent)"
          value={nodes ? t('topo.nodes', { n: nodes.length }) : '…'}
          sub={t('ov.topology.sub')} />
      </div>

      {/* Health stats row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('ov.pods')} value={pods.length} hint={t('ov.healthy', { n: pods.length - unhealthy.length })} />
        <Stat
          label={t('ov.unhealthy')}
          value={unhealthy.length}
          tone={unhealthy.length ? 'crit' : 'ok'}
          hint={unhealthy.length ? t('ov.needAttention') : t('ov.allGood')}
        />
        <Stat label={t('ov.nodes')} value={nodes ? `${nodesReady}/${nodes.length}` : '…'} hint={t('ov.ready')} />
        <Stat
          label={t('ov.restarts')}
          value={pods.reduce((s, p) => s + p.restarts, 0)}
          tone={pods.some((p) => p.restarts > 5) ? 'warn' : 'ink'}
          hint={t('ov.acrossPods')}
        />
      </div>

      {/* Unhealthy pods, called out */}
      {unhealthy.length > 0 && (
        <Card>
          <div className="border-b border-[var(--color-border)] px-5 py-3 text-sm font-medium">
            {t('ov.needsAttention')}
          </div>
          <PodTable pods={unhealthy} />
        </Card>
      )}

      {/* All pods — searchable + paginated so it stays fast on 500+ pods */}
      <AllPods pods={pods} />
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

// AllPods paginates and filters the full pod list so a 500-pod cluster stays
// snappy — a search box + page controls over a fixed page size.
const PAGE_SIZE = 25

function AllPods({ pods }: { pods: Pod[] }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  const filtered = q.trim()
    ? pods.filter((p) => {
        const s = q.toLowerCase()
        return p.name.toLowerCase().includes(s) || p.namespace.toLowerCase().includes(s)
      })
    : pods
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const slice = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-5 py-3">
        <span className="text-sm font-medium">
          {t('ov.allPods')} <span className="text-[var(--color-ink-faint)]">({filtered.length})</span>
        </span>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0) }}
          placeholder={t('fin.search')}
          className="ml-auto w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs outline-none"
        />
      </div>
      <PodTable pods={slice} />
      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-2 text-xs text-[var(--color-ink-dim)]">
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}
            className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-[var(--color-surface-2)]">←</button>
          <span>{safePage + 1} / {pageCount}</span>
          <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}
            className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-[var(--color-surface-2)]">→</button>
        </div>
      )}
    </Card>
  )
}

function PodTable({ pods }: { pods: Pod[] }) {
  const { t } = useT()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
            <th className="px-5 py-2 font-medium">{t('col.namespace')}</th>
            <th className="px-5 py-2 font-medium">{t('col.pod')}</th>
            <th className="px-5 py-2 font-medium">{t('col.status')}</th>
            <th className="px-5 py-2 font-medium">{t('col.ready')}</th>
            <th className="px-5 py-2 font-medium">{t('col.restarts')}</th>
            <th className="px-5 py-2 font-medium">{t('col.age')}</th>
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
