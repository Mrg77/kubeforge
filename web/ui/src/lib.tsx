// Small shared UI primitives used across KubeForge views. Kept dependency-free
// (just Tailwind classes) so the design stays consistent and light.
import type { ReactNode } from 'react'

export function cn(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

/** A card surface — the base container for every panel. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A big headline stat (e.g. "42 pods", "3 unhealthy"). */
export function Stat({
  label,
  value,
  tone = 'ink',
  hint,
}: {
  label: string
  value: ReactNode
  tone?: 'ink' | 'ok' | 'warn' | 'crit'
  hint?: string
}) {
  const color = {
    ink: 'var(--color-ink)',
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    crit: 'var(--color-crit)',
  }[tone]
  return (
    <Card className="p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</div>
      <div className="mt-2 text-3xl font-semibold mono" style={{ color }}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-[var(--color-ink-dim)]">{hint}</div>}
    </Card>
  )
}

/** A colored status pill for pod/node health. */
export function StatusBadge({ status, healthy }: { status: string; healthy?: boolean }) {
  const bad = healthy === false || /Error|BackOff|CrashLoop|Failed|Evicted|OOMKilled|Unknown/.test(status)
  const pending = /Pending|ContainerCreating|Init|Terminating/.test(status)
  const color = bad ? 'var(--color-crit)' : pending ? 'var(--color-warn)' : 'var(--color-ok)'
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium mono"
      style={{ color, background: `${color}1a` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  )
}

export function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-dim)]">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]" />
      loading…
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <Card className="p-4 border-[var(--color-crit)]">
      <div className="text-sm text-[var(--color-crit)]">⚠ {message}</div>
    </Card>
  )
}
