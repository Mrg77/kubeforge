import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { api, type FinReport, type PodCost } from '../api'
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
