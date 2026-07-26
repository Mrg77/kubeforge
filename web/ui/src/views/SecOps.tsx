import { useEffect, useState } from 'react'
import { api, type SecReport, type SecFinding } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'

// SecOps: the security-posture view. A posture score up top, then deterministic
// findings — filterable by severity, category and free text — most-severe first,
// each with a plain "why + fix" explanation and a jump into the Resource stack.
export function SecOps() {
  const [rep, setRep] = useState<SecReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cat, setCat] = useState<string>('all')
  const [sev, setSev] = useState<string>('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    api.secops().then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const c = rep.counts
  const cats = ['all', ...Array.from(new Set(rep.findings.map((f) => f.category)))]

  const shown = rep.findings.filter((f) => {
    if (cat !== 'all' && f.category !== cat) return false
    if (sev !== 'all' && f.severity !== sev) return false
    if (q.trim()) {
      const s = q.toLowerCase()
      if (!f.title.toLowerCase().includes(s) && !f.object.toLowerCase().includes(s)) return false
    }
    return true
  })

  return (
    <div className="flex flex-col gap-5">
      {/* score + severity KPIs */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <ScoreGauge counts={c} scanned={rep.scanned.pods} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SevCard label="Critical" value={c.critical} color="var(--color-crit)" active={sev === 'CRITICAL'} onClick={() => setSev(sev === 'CRITICAL' ? 'all' : 'CRITICAL')} />
          <SevCard label="High" value={c.high} color="var(--color-crit)" active={sev === 'HIGH'} onClick={() => setSev(sev === 'HIGH' ? 'all' : 'HIGH')} />
          <SevCard label="Medium" value={c.medium} color="var(--color-warn)" active={sev === 'MEDIUM'} onClick={() => setSev(sev === 'MEDIUM' ? 'all' : 'MEDIUM')} />
          <SevCard label="Low" value={c.low} color="var(--color-info)" active={sev === 'LOW'} onClick={() => setSev(sev === 'LOW' ? 'all' : 'LOW')} />
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search findings…"
          className="ml-auto w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs outline-none" />
      </div>

      {shown.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--color-ok)]">✓ No findings match these filters.</Card>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((f, i) => <FindingCard key={i} f={f} />)}
        </div>
      )}

      <p className="text-xs text-[var(--color-ink-faint)]">
        Deterministic posture scan — how things are configured, not runtime threat detection.
        A clean report means "no misconfiguration we check for", not "provably secure".
      </p>
    </div>
  )
}

// ScoreGauge turns the weighted findings into a 0–100 posture grade + letter.
function ScoreGauge({ counts, scanned }: {
  counts: { critical: number; high: number; medium: number; low: number }
  scanned: number
}) {
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
        <div className="text-sm font-medium text-[var(--color-ink)]">Posture score</div>
        <div className="mt-1">Weighted by severity across<br />{scanned} pods scanned.</div>
        <div className="mt-1 text-[var(--color-ink-faint)]">Fix criticals first to move the needle.</div>
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

function FindingCard({ f }: { f: SecFinding }) {
  const color = SEV_COLOR[f.severity] ?? 'var(--color-ink-dim)'
  // The object is "<namespace>/<name> (<Kind>)"; link into the Resource stack
  // for that namespace so you can see the offending resource in context.
  const ns = f.namespace || parseNs(f.object)
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded px-2 py-0.5 text-[11px] font-semibold mono"
          style={{ color, background: `${color}1a` }}>{f.severity}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{f.title}</span>
            <span className="text-xs text-[var(--color-ink-faint)]">{f.category}</span>
            {ns && (
              <a href={`?tab=topology&lens=layered&ns=${encodeURIComponent(ns)}`}
                className="ml-auto text-[11px] text-[var(--color-accent)] hover:underline">
                view in stack →
              </a>
            )}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-ink-dim)] mono">{f.object}</div>
          <div className="mt-2 text-sm text-[var(--color-ink-dim)]">{f.detail}</div>
        </div>
      </div>
    </Card>
  )
}

function parseNs(object: string): string {
  const i = object.indexOf('/')
  return i > 0 ? object.slice(0, i) : ''
}
