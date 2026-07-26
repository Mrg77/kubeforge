import { useEffect, useState } from 'react'
import { Activity, Boxes, DollarSign, ShieldCheck, Sparkles, Server, RefreshCw } from 'lucide-react'
import { api, type ClusterInfo } from './api'
import { cn, Spinner } from './lib'
import { Overview } from './views/Overview'
import { Resources } from './views/Resources'
import { SecOps } from './views/SecOps'
import { FinOps } from './views/FinOps'
import { Insights } from './views/Insights'

type Tab = 'overview' | 'resources' | 'finops' | 'secops' | 'insights'

const NAV: { id: Tab; label: string; icon: typeof Activity; ready: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: Activity, ready: true },
  { id: 'resources', label: 'Resources', icon: Boxes, ready: true },
  { id: 'finops', label: 'FinOps', icon: DollarSign, ready: true },
  { id: 'secops', label: 'SecOps', icon: ShieldCheck, ready: true },
  { id: 'insights', label: 'Insights', icon: Sparkles, ready: true },
]

function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get('tab')
  return ['resources','finops','secops','insights'].includes(t ?? '') ? (t as Tab) : 'overview'
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(initialTab)
  const [cluster, setCluster] = useState<ClusterInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Reflect the active tab in the URL so views are deep-linkable and refresh-safe.
  const setTab = (t: Tab) => {
    setTabState(t)
    const url = new URL(location.href)
    url.searchParams.set('tab', t)
    history.replaceState(null, '', url)
  }

  useEffect(() => {
    api.cluster().then(setCluster).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-xl">🔨</span>
          <span className="text-lg font-semibold">
            Kube<span style={{ color: 'var(--color-accent)' }}>Forge</span>
          </span>
        </div>
        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV.map((n) => (
            <button
              key={n.id}
              disabled={!n.ready}
              onClick={() => n.ready && setTab(n.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                tab === n.id
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]',
                !n.ready && 'opacity-40 cursor-not-allowed',
              )}
              style={tab === n.id ? { color: 'var(--color-accent)' } : undefined}
            >
              <n.icon size={16} />
              {n.label}
              {!n.ready && <span className="ml-auto text-[10px] uppercase">soon</span>}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-5 py-4 text-[11px] text-[var(--color-ink-faint)]">
          local-first · nothing exposed
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ClusterHeader cluster={cluster} error={err} />
        <main className="min-h-0 flex-1 overflow-auto p-6">
          {!cluster && !err && <Spinner />}
          {tab === 'overview' && <Overview />}
          {tab === 'resources' && <Resources />}
          {tab === 'secops' && <SecOps />}
          {tab === 'finops' && <FinOps />}
          {tab === 'insights' && <Insights />}
        </main>
      </div>
    </div>
  )
}

function ClusterHeader({ cluster, error }: { cluster: ClusterInfo | null; error: string | null }) {
  const reachable = cluster?.reachable
  const dot = error || cluster?.error ? 'var(--color-crit)' : reachable ? 'var(--color-ok)' : 'var(--color-warn)'
  return (
    <header className="flex items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-3">
      <div className="flex items-center gap-2">
        <Server size={16} className="text-[var(--color-ink-faint)]" />
        <span className="text-sm font-medium mono">{cluster?.context ?? '…'}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: dot }} />
        <span className="text-xs text-[var(--color-ink-dim)]">
          {error || cluster?.error
            ? 'unreachable'
            : reachable
              ? `Kubernetes ${cluster?.version}`
              : 'connecting…'}
        </span>
      </div>
      {cluster?.server && (
        <span className="hidden text-xs text-[var(--color-ink-faint)] mono md:inline">{cluster.server}</span>
      )}
      <button
        onClick={() => location.reload()}
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]"
      >
        <RefreshCw size={12} /> refresh
      </button>
    </header>
  )
}
