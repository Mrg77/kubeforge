import { useEffect, useState } from 'react'
import { Activity, Boxes, Database, DollarSign, Network, ShieldCheck, Sparkles, Server, RefreshCw } from 'lucide-react'
import { api, type ClusterInfo } from './api'
import { cn, Spinner } from './lib'
import { useT, type Locale } from './i18n'
import { Overview } from './views/Overview'
import { Resources } from './views/Resources'
import { SecOps } from './views/SecOps'
import { FinOps } from './views/FinOps'
import { Insights } from './views/Insights'
import { Storage } from './views/Storage'
import { Topology } from './views/Topology'
import { AIButton, AIDrawer } from './AIDrawer'

type Tab = 'overview' | 'topology' | 'resources' | 'storage' | 'finops' | 'secops' | 'insights'

const NAV: { id: Tab; key: string; icon: typeof Activity; ready: boolean }[] = [
  { id: 'overview', key: 'nav.overview', icon: Activity, ready: true },
  { id: 'topology', key: 'nav.topology', icon: Network, ready: true },
  { id: 'resources', key: 'nav.resources', icon: Boxes, ready: true },
  { id: 'storage', key: 'nav.storage', icon: Database, ready: true },
  { id: 'finops', key: 'nav.finops', icon: DollarSign, ready: true },
  { id: 'secops', key: 'nav.secops', icon: ShieldCheck, ready: true },
  { id: 'insights', key: 'nav.insights', icon: Sparkles, ready: true },
]

function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get('tab')
  return ['topology','resources','storage','finops','secops','insights'].includes(t ?? '') ? (t as Tab) : 'overview'
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(initialTab)
  const [cluster, setCluster] = useState<ClusterInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)

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

  const { t, locale, setLocale } = useT()

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
              {t(n.key)}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-5 py-4">
          <LangToggle locale={locale} setLocale={setLocale} />
          <span className="text-[11px] text-[var(--color-ink-faint)]">{t('chrome.localFirst')}</span>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ClusterHeader cluster={cluster} error={err} onAskAI={() => setAiOpen(true)} />
        <AIDrawer open={aiOpen} onClose={() => setAiOpen(false)} onGoInsights={() => setTab('insights')} />
        <main className="min-h-0 flex-1 overflow-auto p-6">
          {!cluster && !err && <Spinner />}
          {tab === 'overview' && <Overview />}
          {tab === 'topology' && <Topology />}
          {tab === 'resources' && <Resources />}
          {tab === 'storage' && <Storage />}
          {tab === 'secops' && <SecOps />}
          {tab === 'finops' && <FinOps />}
          {tab === 'insights' && <Insights />}
        </main>
      </div>
    </div>
  )
}

function LangToggle({ locale, setLocale }: { locale: Locale; setLocale: (l: Locale) => void }) {
  return (
    <div className="inline-flex w-fit rounded-md border border-[var(--color-border)] p-0.5 text-[11px]">
      {(['en', 'fr'] as Locale[]).map((l) => (
        <button key={l} onClick={() => setLocale(l)}
          className={cn('rounded px-2 py-0.5 uppercase',
            locale === l ? 'bg-[var(--color-accent)] text-black font-medium' : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]')}>
          {l}
        </button>
      ))}
    </div>
  )
}

function ClusterHeader({ cluster, error, onAskAI }: { cluster: ClusterInfo | null; error: string | null; onAskAI: () => void }) {
  const { t } = useT()
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
            ? t('chrome.unreachable')
            : reachable
              ? `Kubernetes ${cluster?.version}`
              : t('chrome.connecting')}
        </span>
      </div>
      {cluster?.server && (
        <span className="hidden text-xs text-[var(--color-ink-faint)] mono md:inline">{cluster.server}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <AIButton onOpen={onAskAI} />
        <button
          onClick={() => location.reload()}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)]"
        >
          <RefreshCw size={12} /> {t('chrome.refresh')}
        </button>
      </div>
    </header>
  )
}
