import { useEffect, useState } from 'react'
import { api, type SecReport, type SecFinding } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'
import { useT } from '../i18n'

// SecOps: the security-posture view. A posture score up top, then deterministic
// findings — filterable by severity, category and free text — most-severe first,
// each with a plain "why + fix" explanation and a jump into the Resource stack.
// fTitle/fDetail translate a finding via its code, falling back to the backend's
// English text for any code the UI doesn't know yet.
function useFindingText() {
  const { t } = useT()
  return {
    title: (f: SecFinding) => {
      const k = `sec.f.${f.code}.t`
      const v = t(k)
      return v === k ? f.title : v
    },
    detail: (f: SecFinding) => {
      const k = `sec.f.${f.code}.d`
      const v = t(k)
      return v === k ? f.detail : v
    },
  }
}

export function SecOps() {
  const { t } = useT()
  const ft = useFindingText()
  const [rep, setRep] = useState<SecReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cat, setCat] = useState<string>('all')
  const [sev, setSev] = useState<string>('all')
  const [q, setQ] = useState('')
  const [hideSystem, setHideSystem] = useState(true)

  useEffect(() => {
    api.secops().then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const c = rep.counts
  const cats = ['all', ...Array.from(new Set(rep.findings.map((f) => f.category)))]
  const systemCount = rep.findings.filter((f) => f.system).length

  const shown = rep.findings.filter((f) => {
    if (hideSystem && f.system) return false
    if (cat !== 'all' && f.category !== cat) return false
    if (sev !== 'all' && f.severity !== sev) return false
    if (q.trim()) {
      const s = q.toLowerCase()
      if (!ft.title(f).toLowerCase().includes(s) && !f.object.toLowerCase().includes(s)) return false
    }
    return true
  })

  // Group the shown findings by code, most-severe/biggest first.
  const groups = groupByCode(shown)

  return (
    <div className="flex flex-col gap-5">
      {/* score + severity KPIs. The score is built from your OWN findings
          (excluding system namespaces), so Kubernetes' privileged system pods
          don't sink every cluster's grade. */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <ScoreGauge counts={rep.ownCounts} scanned={rep.scanned.pods} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SevCard label={t('sec.critical')} value={c.critical} color="var(--color-crit)" active={sev === 'CRITICAL'} onClick={() => setSev(sev === 'CRITICAL' ? 'all' : 'CRITICAL')} />
          <SevCard label={t('sec.high')} value={c.high} color="var(--color-crit)" active={sev === 'HIGH'} onClick={() => setSev(sev === 'HIGH' ? 'all' : 'HIGH')} />
          <SevCard label={t('sec.medium')} value={c.medium} color="var(--color-warn)" active={sev === 'MEDIUM'} onClick={() => setSev(sev === 'MEDIUM' ? 'all' : 'MEDIUM')} />
          <SevCard label={t('sec.low')} value={c.low} color="var(--color-info)" active={sev === 'LOW'} onClick={() => setSev(sev === 'LOW' ? 'all' : 'LOW')} />
        </div>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        {cats.map((k) => (
          <button key={k} onClick={() => setCat(k)}
            className={cn('rounded-full border px-3 py-1 text-xs',
              cat === k
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]')}>
            {k}
            {k !== 'all' && <span className="ml-1.5 text-[var(--color-ink-faint)]">{rep.findings.filter((f) => f.category === k).length}</span>}
          </button>
        ))}
        <label className="ml-1 flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)]">
          <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} />
          {t('sec.hideSystem')}
          {hideSystem && systemCount > 0 && (
            <span className="text-[var(--color-ink-faint)]">({t('sec.systemHidden', { n: systemCount })})</span>
          )}
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sec.searchFindings')}
          className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs outline-none" />
        <button onClick={() => exportCSV(shown, ft)}
          className="ml-auto rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]">
          ↓ {t('sec.export')} CSV
        </button>
      </div>

      {groups.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--color-ok)]">{t('sec.noMatch')}</Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => <FindingGroup key={g.code} group={g} ft={ft} />)}
        </div>
      )}

      <p className="text-xs text-[var(--color-ink-faint)]">{t('sec.disclaimer')}</p>
    </div>
  )
}

// ---- grouping -------------------------------------------------------------

interface Group {
  code: string
  severity: SecFinding['severity']
  category: string
  findings: SecFinding[]
}

const SEV_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }

function groupByCode(findings: SecFinding[]): Group[] {
  const by = new Map<string, Group>()
  for (const f of findings) {
    let g = by.get(f.code)
    if (!g) { g = { code: f.code, severity: f.severity, category: f.category, findings: [] }; by.set(f.code, g) }
    g.findings.push(f)
  }
  return [...by.values()].sort((a, b) =>
    (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (b.findings.length - a.findings.length))
}

// FindingGroup is a collapsible card: one header per finding type with its count,
// expanding to the affected objects. Collapses 48 "run as root" rows into one.
function FindingGroup({ group, ft }: { group: Group; ft: ReturnType<typeof useFindingText> }) {
  const { t } = useT()
  const [open, setOpen] = useState(group.findings.length === 1)
  const color = SEV_COLOR[group.severity] ?? 'var(--color-ink-dim)'
  const sample = group.findings[0]
  return (
    <Card className="overflow-hidden">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 p-4 text-left hover:bg-[var(--color-surface-2)]">
        <span className="mt-0.5 rounded px-2 py-0.5 text-[11px] font-semibold mono" style={{ color, background: `${color}1a` }}>
          {group.severity}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[var(--color-ink-faint)]">{open ? '▾' : '▸'}</span>
            <span className="font-medium">{ft.title(sample)}</span>
            <span className="text-xs text-[var(--color-ink-faint)]">{group.category}</span>
            <span className="ml-auto rounded-full px-2 py-0.5 text-[11px]" style={{ color, background: `${color}1a` }}>
              {t(group.findings.length > 1 ? 'sec.affected' : 'sec.affected1', { n: group.findings.length })}
            </span>
          </div>
          <div className="mt-2 text-sm text-[var(--color-ink-dim)]">{ft.detail(sample)}</div>
        </div>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)]">
          {group.findings.map((f, i) => {
            const ns = f.namespace || parseNs(f.object)
            return (
              <div key={i} className="flex items-center gap-2 border-b border-[var(--color-border)]/40 px-4 py-1.5 text-xs last:border-0">
                <span className="mono text-[var(--color-ink-dim)]">{f.object}</span>
                {ns && (
                  <a href={`?tab=topology&lens=layered&ns=${encodeURIComponent(ns)}`}
                    className="ml-auto shrink-0 text-[var(--color-accent)] hover:underline">
                    {t('sec.viewInStack')}
                  </a>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---- CSV export ------------------------------------------------------------

function exportCSV(findings: SecFinding[], ft: ReturnType<typeof useFindingText>) {
  const esc = (s: string) => `"${(s ?? '').replaceAll('"', '""')}"`
  const rows = [
    ['severity', 'category', 'title', 'object', 'namespace', 'detail'].join(','),
    ...findings.map((f) => [
      f.severity, f.category, ft.title(f), f.object, f.namespace ?? parseNs(f.object), ft.detail(f),
    ].map(esc).join(',')),
  ]
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'kubeforge-secops.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ScoreGauge turns the weighted findings into a 0–100 posture grade + letter.
function ScoreGauge({ counts, scanned }: {
  counts: { critical: number; high: number; medium: number; low: number }
  scanned: number
}) {
  const { t } = useT()
  const penalty = counts.critical * 12 + counts.high * 6 + counts.medium * 2 + counts.low * 0.5
  const score = Math.max(0, Math.round(100 - penalty))
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F'
  const color = score >= 75 ? 'var(--color-ok)' : score >= 50 ? 'var(--color-warn)' : 'var(--color-crit)'
  const R = 46, Circ = 2 * Math.PI * R
  return (
    <Card className="flex items-center gap-4 p-5">
      <svg width={116} height={116} viewBox="0 0 116 116">
        <circle cx={58} cy={58} r={R} fill="none" stroke="var(--color-border)" strokeWidth={10} />
        <circle cx={58} cy={58} r={R} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
          strokeDasharray={`${(score / 100) * Circ} ${Circ}`} transform="rotate(-90 58 58)" />
        <text x={58} y={54} textAnchor="middle" fontSize={26} fontWeight={700} fill="var(--color-ink)">{score}</text>
        <text x={58} y={74} textAnchor="middle" fontSize={13} fontWeight={700} fill={color}>{grade}</text>
      </svg>
      <div className="text-xs text-[var(--color-ink-dim)]">
        <div className="text-sm font-medium text-[var(--color-ink)]">{t('sec.postureScore')}</div>
        <div className="mt-1">{t('sec.postureSub', { n: scanned })}</div>
        <div className="mt-1 text-[var(--color-ink-faint)]">{t('sec.fixFirst')}</div>
      </div>
    </Card>
  )
}

function SevCard({ label, value, color, active, onClick }: {
  label: string; value: number; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className={cn('rounded-xl border p-3 text-left transition', active ? 'ring-2' : '')}
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)',
        ...(active ? { boxShadow: `0 0 0 2px ${color}` } : {}) }}>
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold" style={{ color: value ? color : 'var(--color-ink)' }}>{value}</div>
    </button>
  )
}

const SEV_COLOR: Record<string, string> = {
  CRITICAL: 'var(--color-crit)',
  HIGH: 'var(--color-crit)',
  MEDIUM: 'var(--color-warn)',
  LOW: 'var(--color-info)',
  INFO: 'var(--color-ink-dim)',
}

function parseNs(object: string): string {
  const i = object.indexOf('/')
  return i > 0 ? object.slice(0, i) : ''
}
