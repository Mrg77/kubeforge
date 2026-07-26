import { useEffect, useState } from 'react'
import { api, type SecReport, type SecFinding } from '../api'
import { Card, Stat, Spinner, ErrorNote, cn } from '../lib'

// SecOps: the security-posture view. Deterministic findings, most-severe first,
// grouped by category, each with a plain "why + fix" explanation.
export function SecOps() {
  const [rep, setRep] = useState<SecReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cat, setCat] = useState<string>('all')

  useEffect(() => {
    api.secops().then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const c = rep.counts
  const cats = ['all', ...Array.from(new Set(rep.findings.map((f) => f.category)))]
  const shown = cat === 'all' ? rep.findings : rep.findings.filter((f) => f.category === cat)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Critical" value={c.critical} tone={c.critical ? 'crit' : 'ok'} />
        <Stat label="High" value={c.high} tone={c.high ? 'crit' : 'ok'} />
        <Stat label="Medium" value={c.medium} tone={c.medium ? 'warn' : 'ok'} />
        <Stat label="Low" value={c.low} tone="ink" />
        <Stat
          label="Scanned"
          value={rep.scanned.pods}
          hint={`pods · ${rep.scanned.namespaces} namespaces`}
        />
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {cats.map((k) => (
          <button
            key={k}
            onClick={() => setCat(k)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              cat === k
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]',
            )}
          >
            {k}
            {k !== 'all' && (
              <span className="ml-1.5 text-[var(--color-ink-faint)]">
                {rep.findings.filter((f) => f.category === k).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card className="p-6 text-sm text-[var(--color-ok)]">
          ✓ No posture issues in this category.
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((f, i) => (
            <FindingCard key={i} f={f} />
          ))}
        </div>
      )}

      <p className="text-xs text-[var(--color-ink-faint)]">
        Deterministic posture scan — how things are configured, not runtime threat detection.
        A clean report means "no misconfiguration we check for", not "provably secure".
      </p>
    </div>
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
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 rounded px-2 py-0.5 text-[11px] font-semibold mono"
          style={{ color, background: `${color}1a` }}
        >
          {f.severity}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{f.title}</span>
            <span className="text-xs text-[var(--color-ink-faint)]">{f.category}</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-ink-dim)] mono">{f.object}</div>
          <div className="mt-2 text-sm text-[var(--color-ink-dim)]">{f.detail}</div>
        </div>
      </div>
    </Card>
  )
}
