import { useEffect, useMemo, useState } from 'react'
import { Treemap, ResponsiveContainer } from 'recharts'
import { api, type FinReport, type WorkloadCost, type PodCost, type NamespaceCost } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'

// FinOps — a real cost dashboard: efficiency gauge, spend/waste KPIs, a namespace
// cost treemap, top wasters, and a filterable, sortable, workload-grouped table.
// Prices are editable (with cloud presets) and recompute everything live.

const PRESETS: Record<string, { cpuHour: number; gbHour: number }> = {
  Default: { cpuHour: 0.031, gbHour: 0.004 },
  AWS: { cpuHour: 0.0416, gbHour: 0.0046 }, // ~m5 on-demand
  GCP: { cpuHour: 0.0334, gbHour: 0.0045 }, // ~n2 on-demand
  Azure: { cpuHour: 0.04, gbHour: 0.005 },
}

export function FinOps() {
  const [rep, setRep] = useState<FinReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [prices, setPrices] = useState(PRESETS.Default)

  useEffect(() => {
    setRep(null)
    api.finops(prices).then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [prices])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const cpuEff = rep.totalCpuReq > 0 ? rep.totalCpuUsed / rep.totalCpuReq : 0
  const wasteRatio = rep.totalMonthly > 0 ? rep.wastedMonthly / rep.totalMonthly : 0

  return (
    <div className="flex flex-col gap-5">
      {!rep.metricsAvailable && (
        <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-4 py-3 text-sm text-[var(--color-warn)]">
          metrics-server isn't installed, so real usage is unknown. Costs reflect what pods{' '}
          <em>reserve</em>, but the reserved-vs-used waste gap can't be computed.
        </div>
      )}

      {/* KPI row + efficiency gauge */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_auto]">
        <Kpi label="Reserved / mo" value={`$${round0(rep.totalMonthly)}`} sub="estimated" />
        <Kpi
          label="Wasted / mo"
          value={`$${round0(rep.wastedMonthly)}`}
          sub={`${Math.round(wasteRatio * 100)}% of reserved`}
          tone={wasteRatio > 0.5 ? 'crit' : wasteRatio > 0.25 ? 'warn' : 'ok'}
        />
        <Kpi
          label="Workloads over-provisioned"
          value={String(rep.workloads.filter((w) => w.level === 'high').length)}
          sub="high waste"
          tone="warn"
        />
        {rep.metricsAvailable && <EfficiencyGauge ratio={cpuEff} />}
      </div>

      <PriceEditor prices={prices} onChange={setPrices} />

      <div className="grid gap-5 lg:grid-cols-2">
        {rep.namespaces.length > 0 && rep.totalMonthly > 0 && (
          <Card className="p-5">
            <SectionTitle title="Cost map — spend by namespace"
              sub="Size = $/mo reserved · color = share wasted" />
            <CostTreemap namespaces={rep.namespaces} />
          </Card>
        )}
        <Card className="p-5">
          <SectionTitle title="Top wasters" sub="Workloads leaking the most, right-size these first" />
          <TopWasters workloads={rep.workloads} />
        </Card>
      </div>

      <WorkloadTable rep={rep} />
    </div>
  )
}

// ---- KPI cards & gauge -----------------------------------------------------

function Kpi({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'crit'
}) {
  const c = tone === 'crit' ? 'var(--color-crit)' : tone === 'warn' ? 'var(--color-warn)' : tone === 'ok' ? 'var(--color-ok)' : 'var(--color-ink)'
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</div>
      <div className="mt-1 text-3xl font-semibold" style={{ color: c }}>{value}</div>
      {sub && <div className="mt-1 text-xs text-[var(--color-ink-dim)]">{sub}</div>}
    </Card>
  )
}

// EfficiencyGauge is a radial arc: how much of reserved CPU is actually used.
function EfficiencyGauge({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100)
  const R = 42, C = 2 * Math.PI * R
  const dash = Math.min(ratio, 1) * C
  const color = ratio < 0.3 ? 'var(--color-crit)' : ratio < 0.6 ? 'var(--color-warn)' : 'var(--color-ok)'
  return (
    <Card className="flex items-center gap-4 p-4">
      <svg width={104} height={104} viewBox="0 0 104 104">
        <circle cx={52} cy={52} r={R} fill="none" stroke="var(--color-border)" strokeWidth={10} />
        <circle cx={52} cy={52} r={R} fill="none" stroke={color} strokeWidth={10}
          strokeDasharray={`${dash} ${C}`} strokeLinecap="round"
          transform="rotate(-90 52 52)" />
        <text x={52} y={50} textAnchor="middle" fontSize={22} fontWeight={700} fill="var(--color-ink)">{pct}%</text>
        <text x={52} y={66} textAnchor="middle" fontSize={9} fill="var(--color-ink-faint)">CPU used</text>
      </svg>
      <div className="text-xs text-[var(--color-ink-dim)]">
        <div className="font-medium text-[var(--color-ink)]">Cluster efficiency</div>
        <div className="mt-1">of reserved CPU is actually used.</div>
        <div className="mt-1 text-[var(--color-ink-faint)]">The rest is capacity you pay for and don't use.</div>
      </div>
    </Card>
  )
}

// ---- Price editor ----------------------------------------------------------

function PriceEditor({ prices, onChange }: {
  prices: { cpuHour: number; gbHour: number }
  onChange: (p: { cpuHour: number; gbHour: number }) => void
}) {
  const activePreset = Object.entries(PRESETS).find(
    ([, p]) => p.cpuHour === prices.cpuHour && p.gbHour === prices.gbHour,
  )?.[0]
  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <span className="text-xs font-medium text-[var(--color-ink-dim)]">Pricing</span>
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-[var(--color-ink-faint)]">$/CPU·h</span>
        <input type="number" step="0.001" value={prices.cpuHour}
          onChange={(e) => onChange({ ...prices, cpuHour: +e.target.value })}
          className="w-20 rounded-md bg-[var(--color-surface-2)] px-2 py-1 mono outline-none" />
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-[var(--color-ink-faint)]">$/GB·h</span>
        <input type="number" step="0.001" value={prices.gbHour}
          onChange={(e) => onChange({ ...prices, gbHour: +e.target.value })}
          className="w-20 rounded-md bg-[var(--color-surface-2)] px-2 py-1 mono outline-none" />
      </label>
      <div className="ml-auto flex items-center gap-1">
        {Object.keys(PRESETS).map((k) => (
          <button key={k} onClick={() => onChange(PRESETS[k])}
            className={cn('rounded-md px-2.5 py-1 text-xs',
              activePreset === k
                ? 'bg-[var(--color-accent)] text-black font-medium'
                : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]')}>
            {k}
          </button>
        ))}
      </div>
    </Card>
  )
}

// ---- Top wasters -----------------------------------------------------------

function TopWasters({ workloads }: { workloads: WorkloadCost[] }) {
  const top = workloads.filter((w) => w.wastedMonthly > 0).slice(0, 6)
  if (top.length === 0)
    return <div className="text-sm text-[var(--color-ink-dim)]">No measurable waste — nicely sized.</div>
  const max = top[0].wastedMonthly
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {top.map((w) => (
        <div key={`${w.namespace}/${w.name}`} className="flex items-center gap-3">
          <div className="w-40 shrink-0 truncate text-xs">
            <span className="mono text-[var(--color-ink)]">{w.name}</span>
            <span className="ml-1 text-[var(--color-ink-faint)]">{w.namespace}</span>
          </div>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--color-bg)]">
            <div className="h-full rounded" style={{
              width: `${(w.wastedMonthly / max) * 100}%`,
              background: 'var(--color-warn)',
            }} />
          </div>
          <span className="w-16 shrink-0 text-right text-xs mono text-[var(--color-warn)]">
            ${round0(w.wastedMonthly)}/mo
          </span>
        </div>
      ))}
    </div>
  )
}

// ---- Workload table (filter + search + sort + expand to pods) --------------

type SortKey = 'monthlyCost' | 'wastedMonthly' | 'cpuUsage' | 'name'

function WorkloadTable({ rep }: { rep: FinReport }) {
  const [ns, setNs] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('wastedMonthly')
  const [expanded, setExpanded] = useState<string | null>(null)

  const namespaces = useMemo(
    () => ['all', ...[...new Set(rep.workloads.map((w) => w.namespace))].sort()],
    [rep],
  )
  const podsByWorkload = useMemo(() => {
    const m = new Map<string, PodCost[]>()
    for (const p of rep.pods) {
      const k = `${p.namespace}/${p.owner}`
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(p)
    }
    return m
  }, [rep])

  const rows = useMemo(() => {
    let ws = rep.workloads
    if (ns !== 'all') ws = ws.filter((w) => w.namespace === ns)
    if (q.trim()) {
      const s = q.toLowerCase()
      ws = ws.filter((w) => w.name.toLowerCase().includes(s) || w.namespace.toLowerCase().includes(s))
    }
    return [...ws].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      return (b[sort] as number) - (a[sort] as number)
    })
  }, [rep, ns, q, sort])

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SectionTitle title="Cost by workload" sub={`${rows.length} workloads · click to expand replicas`} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={ns} onChange={(e) => setNs(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs mono outline-none">
            {namespaces.map((n) => <option key={n} value={n}>{n === 'all' ? 'all namespaces' : n}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…"
            className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs outline-none" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">
              <Th label="Workload" k="name" sort={sort} setSort={setSort} />
              <th className="py-2 pr-4">Pods</th>
              <Th label="CPU used/req" k="cpuUsage" sort={sort} setSort={setSort} />
              <th className="py-2 pr-4">Mem used/req</th>
              <th className="py-2 pr-4">Waste</th>
              <Th label="$/mo cost" k="monthlyCost" sort={sort} setSort={setSort} align="right" />
              <Th label="$/mo wasted" k="wastedMonthly" sort={sort} setSort={setSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const key = `${w.namespace}/${w.name}`
              const open = expanded === key
              const pods = podsByWorkload.get(key) ?? []
              return (
                <>
                  <tr key={key} onClick={() => setExpanded(open ? null : key)}
                    className="cursor-pointer border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-2)]">
                    <td className="py-2 pr-4">
                      <span className="mr-1 text-[var(--color-ink-faint)]">{open ? '▾' : '▸'}</span>
                      <span className="mono text-[var(--color-ink)]">{w.name}</span>
                      <span className="ml-2 text-[11px] text-[var(--color-ink-faint)]">{w.namespace} · {w.kind}</span>
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-ink-dim)]">{w.pods}</td>
                    <td className="py-2 pr-4 mono text-xs">{fmt(w.cpuUsage)}/{fmt(w.cpuRequest)}</td>
                    <td className="py-2 pr-4 mono text-xs">{fmt(w.memUsageGB)}/{fmt(w.memRequestGB)}</td>
                    <td className="py-2 pr-4"><WasteBadge level={w.level} /></td>
                    <td className="py-2 pr-4 text-right mono">${round2(w.monthlyCost)}</td>
                    <td className="py-2 text-right mono" style={{ color: w.wastedMonthly > 0 ? 'var(--color-warn)' : 'var(--color-ink-faint)' }}>
                      ${round2(w.wastedMonthly)}
                    </td>
                  </tr>
                  {open && pods.map((p) => (
                    <tr key={`${key}/${p.name}`} className="border-b border-[var(--color-border)]/30 bg-[var(--color-bg)] text-xs">
                      <td className="py-1.5 pl-8 pr-4 mono text-[var(--color-ink-dim)]">{p.name}</td>
                      <td></td>
                      <td className="py-1.5 pr-4 mono">{fmt(p.cpuUsage)}/{fmt(p.cpuRequest)}</td>
                      <td className="py-1.5 pr-4 mono">{fmt(p.memUsageGB)}/{fmt(p.memRequestGB)}</td>
                      <td className="py-1.5 pr-4"><WasteBadge level={p.level} /></td>
                      <td className="py-1.5 pr-4 text-right mono">${round2(p.monthlyCost)}</td>
                      <td className="py-1.5 text-right mono text-[var(--color-warn)]">${round2(p.wastedMonthly)}</td>
                    </tr>
                  ))}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Th({ label, k, sort, setSort, align }: {
  label: string; k: SortKey; sort: SortKey; setSort: (k: SortKey) => void; align?: 'right'
}) {
  return (
    <th className={cn('py-2 pr-4 cursor-pointer select-none hover:text-[var(--color-ink)]', align === 'right' && 'text-right')}
      onClick={() => setSort(k)}>
      {label}{sort === k ? ' ↓' : ''}
    </th>
  )
}

function WasteBadge({ level }: { level: string }) {
  const map: Record<string, { c: string; t: string }> = {
    ok: { c: 'var(--color-ok)', t: 'ok' },
    moderate: { c: 'var(--color-warn)', t: 'moderate' },
    high: { c: 'var(--color-crit)', t: 'high' },
    unbounded: { c: 'var(--color-ink-faint)', t: 'no limits' },
  }
  const m = map[level] ?? map.ok
  return <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: m.c, background: `color-mix(in srgb, ${m.c} 15%, transparent)` }}>{m.t}</span>
}

// ---- shared bits + treemap (kept from before) ------------------------------

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <div className="text-sm font-medium">{title}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{sub}</div>}
    </div>
  )
}

function CostTreemap({ namespaces }: { namespaces: NamespaceCost[] }) {
  const data = namespaces.map((n) => ({
    name: n.namespace, size: Math.max(n.monthlyCost, 0.5),
    waste: n.monthlyCost > 0 ? n.wastedMonthly / n.monthlyCost : 0,
    cost: n.monthlyCost, wasted: n.wastedMonthly,
  }))
  return (
    <div className="mt-3">
      <ResponsiveContainer width="100%" height={280}>
        <Treemap data={data} dataKey="size" content={<TreemapCell />} isAnimationActive={false} />
      </ResponsiveContainer>
    </div>
  )
}

function wasteColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio))
  const hue = (1 - r) * 130 // 130 green → 0 red
  return `hsl(${hue} 55% 42%)`
}

function TreemapCell(props: any) {
  const { x, y, width, height, name, cost, waste } = props
  if (width < 30 || height < 20) return null
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4}
        fill={wasteColor(waste ?? 0)} stroke="var(--color-bg)" strokeWidth={2} />
      {width > 60 && height > 34 && (
        <>
          <text x={x + 8} y={y + 18} fill="#fff" fontSize={12} fontWeight={600}>{name}</text>
          <text x={x + 8} y={y + 33} fill="#ffffffcc" fontSize={10}>${round0(cost)}/mo</text>
        </>
      )}
    </g>
  )
}

function fmt(n: number) { return n < 0.01 ? '~0' : n.toFixed(2) }
function round0(n: number) { return Math.round(n) }
function round2(n: number) { return (Math.round(n * 100) / 100).toFixed(2) }
