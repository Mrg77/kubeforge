import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Treemap } from 'recharts'
import { api, type FinReport, type PodCost, type NamespaceCost } from '../api'
import { Card, Stat, Spinner, ErrorNote, cn } from '../lib'

// FinOps: "where am I wasting money?" — reserved vs actually used, ranked by
// the monthly cost of the gap, with a right-sizing recommendation per pod.
export function FinOps() {
  const [rep, setRep] = useState<FinReport | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.finops().then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const wastePct = rep.totalMonthly > 0 ? (rep.wastedMonthly / rep.totalMonthly) * 100 : 0
  const topWaste = rep.pods.filter((p) => p.wastedMonthly > 0).slice(0, 10)
  const chartData = topWaste.map((p) => ({
    name: p.name.length > 22 ? p.name.slice(0, 22) + '…' : p.name,
    used: round(p.cpuUsage * 100) / 100,
    wasted: round((p.cpuRequest - p.cpuUsage) * 100) / 100,
  }))

  return (
    <div className="flex flex-col gap-6">
      {!rep.metricsAvailable && (
        <Card className="p-4 border-[var(--color-warn)]">
          <div className="text-sm text-[var(--color-warn)]">
            metrics-server isn't installed, so real usage is unknown. Costs below reflect what
            pods <em>reserve</em>, but the reserved-vs-used waste gap can't be computed.
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Reserved / mo" value={`$${rep.totalMonthly.toFixed(0)}`} hint="estimated" />
        <Stat
          label="Wasted / mo"
          value={`$${rep.wastedMonthly.toFixed(0)}`}
          tone={wastePct > 40 ? 'crit' : wastePct > 15 ? 'warn' : 'ok'}
          hint={`${wastePct.toFixed(0)}% of reserved`}
        />
        <Stat
          label="Over-provisioned"
          value={rep.pods.filter((p) => p.level === 'high').length}
          tone="warn"
          hint="pods, high waste"
        />
        <Stat
          label="Unbounded"
          value={rep.pods.filter((p) => p.level === 'unbounded').length}
          tone={rep.pods.some((p) => p.level === 'unbounded') ? 'warn' : 'ok'}
          hint="no requests set"
        />
      </div>

      {/* Cost treemap: size = spend, color = waste ratio, per namespace */}
      {rep.namespaces.length > 0 && rep.totalMonthly > 0 && <CostTreemap namespaces={rep.namespaces} />}

      {/* Reserved vs used, top wasters */}
      {chartData.length > 0 && (
        <Card className="p-5">
          <div className="mb-4 text-sm font-medium">
            CPU: used vs wasted (top {chartData.length}, cores)
          </div>
          <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 34)}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20 }}>
              <XAxis type="number" stroke="var(--color-ink-faint)" fontSize={11} />
              <YAxis
                type="category"
                dataKey="name"
                width={170}
                stroke="var(--color-ink-faint)"
                fontSize={11}
                tick={{ fill: 'var(--color-ink-dim)' }}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  color: 'var(--color-ink)',
                }}
                cursor={{ fill: 'var(--color-surface-2)' }}
              />
              <Bar dataKey="used" stackId="a" fill="var(--color-ok)" name="used" radius={[3, 0, 0, 3]} />
              <Bar dataKey="wasted" stackId="a" name="wasted" radius={[0, 3, 3, 0]}>
                {chartData.map((_, i) => (
                  <Cell key={i} fill="var(--color-warn)" />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Per-pod detail */}
      <Card>
        <div className="border-b border-[var(--color-border)] px-5 py-3 text-sm font-medium">
          Pods by monthly waste
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                <th className="px-5 py-2 font-medium">Pod</th>
                <th className="px-5 py-2 font-medium">CPU (used/req)</th>
                <th className="px-5 py-2 font-medium">Mem (used/req)</th>
                <th className="px-5 py-2 font-medium">Waste</th>
                <th className="px-5 py-2 font-medium">$/mo wasted</th>
              </tr>
            </thead>
            <tbody>
              {rep.pods.slice(0, 30).map((p) => (
                <Row key={`${p.namespace}/${p.name}`} p={p} metrics={rep.metricsAvailable} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-[var(--color-ink-faint)]">
        Cost is an estimate from a fixed price per core/GB (${rep.prices.perCPUHour}/vCPU·h,
        ${rep.prices.perGBHour}/GB·h), meant to rank waste and guide right-sizing — not a cloud bill.
      </p>
    </div>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  high: 'var(--color-crit)',
  moderate: 'var(--color-warn)',
  unbounded: 'var(--color-warn)',
  ok: 'var(--color-ok)',
}

function Row({ p, metrics }: { p: PodCost; metrics: boolean }) {
  const color = LEVEL_COLOR[p.level] ?? 'var(--color-ink-dim)'
  return (
    <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]" title={p.recommendation}>
      <td className="px-5 py-2 mono">
        <span className="text-[var(--color-ink-dim)]">{p.namespace}/</span>
        {p.name}
      </td>
      <td className="px-5 py-2 mono text-[var(--color-ink-dim)]">
        {metrics ? `${p.cpuUsage}/${p.cpuRequest}` : `–/${p.cpuRequest}`}
      </td>
      <td className="px-5 py-2 mono text-[var(--color-ink-dim)]">
        {metrics ? `${p.memUsageGB}/${p.memRequestGB}` : `–/${p.memRequestGB}`}
      </td>
      <td className="px-5 py-2">
        <span
          className={cn('rounded px-2 py-0.5 text-[11px] font-medium mono')}
          style={{ color, background: `${color}1a` }}
        >
          {p.level}
        </span>
      </td>
      <td className="px-5 py-2 mono" style={p.wastedMonthly > 0 ? { color: 'var(--color-warn)' } : undefined}>
        ${p.wastedMonthly.toFixed(2)}
      </td>
    </tr>
  )
}

function round(n: number) {
  return Math.round(n)
}

// CostTreemap: each rectangle is a namespace, sized by monthly spend and colored
// by waste ratio (green = efficient, red = mostly wasted). One glance shows
// where the money goes and where it's burned.
function CostTreemap({ namespaces }: { namespaces: NamespaceCost[] }) {
  const data = namespaces
    .filter((n) => n.monthlyCost > 0)
    .map((n) => ({
      name: n.namespace,
      size: Math.round(n.monthlyCost),
      wasted: Math.round(n.wastedMonthly),
      ratio: n.monthlyCost > 0 ? n.wastedMonthly / n.monthlyCost : 0,
    }))

  return (
    <Card className="p-5">
      <div className="mb-1 text-sm font-medium">Cost map — spend by namespace</div>
      <div className="mb-4 text-xs text-[var(--color-ink-faint)]">
        Size = $/mo reserved · color = share wasted (green efficient → red mostly idle)
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <Treemap
          data={data}
          dataKey="size"
          stroke="var(--color-bg)"
          content={<TreemapCell />}
          isAnimationActive={false}
        >
          <Tooltip content={<TreemapTooltip />} />
        </Treemap>
      </ResponsiveContainer>
    </Card>
  )
}

// wasteColor blends green→amber→red by waste ratio.
function wasteColor(ratio: number): string {
  if (ratio >= 0.6) return '#f85149' // crit
  if (ratio >= 0.3) return '#d29922' // warn
  if (ratio >= 0.15) return '#8a7b3a'
  return '#2f6f4f' // efficient green
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TreemapCell(props: any) {
  const { x, y, width, height, name, ratio, size } = props
  if (width < 2 || height < 2) return null
  const fill = wasteColor(ratio ?? 0)
  const showLabel = width > 60 && height > 30
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="var(--color-bg)" strokeWidth={2} rx={3} />
      {showLabel && (
        <>
          <text x={x + 8} y={y + 20} fill="#fff" fontSize={12} fontWeight={600} className="mono">
            {name}
          </text>
          <text x={x + 8} y={y + 38} fill="#ffffffcc" fontSize={11} className="mono">
            ${size}/mo
          </text>
        </>
      )}
    </g>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TreemapTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
      <div className="font-medium mono">{d.name}</div>
      <div className="mt-1 text-[var(--color-ink-dim)]">${d.size}/mo reserved</div>
      <div className="text-[var(--color-warn)]">${d.wasted}/mo wasted ({Math.round(d.ratio * 100)}%)</div>
    </div>
  )
}
