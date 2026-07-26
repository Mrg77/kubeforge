import { useEffect, useState } from 'react'
import { Sparkles, X, TrendingUp, Settings } from 'lucide-react'
import { api, type AIConfig } from './api'
import { useT } from './i18n'

// AIDrawer is the always-reachable AI surface: a button lives in the header on
// every view, and this slides in from the right. It keeps the AI opt-in and
// out of the way — nothing runs until you click — while making it obvious the
// capability is there, instead of hiding it inside one tab.
export function AIButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useT()
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => {
    api.aiConfig().then((c) => setConfigured(c.configured)).catch(() => setConfigured(false))
  }, [])
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors"
      style={{
        borderColor: 'var(--color-accent)',
        color: 'var(--color-accent)',
        background: 'var(--color-accent-soft)',
      }}
    >
      <Sparkles size={13} />
      {t('chrome.askAI')}
      {configured === false && (
        <span className="rounded-full bg-[var(--color-warn)] px-1 text-[9px] text-black">{t('chrome.setup')}</span>
      )}
    </button>
  )
}

export function AIDrawer({ open, onClose, onGoInsights }: {
  open: boolean
  onClose: () => void
  onGoInsights: () => void
}) {
  const [cfg, setCfg] = useState<AIConfig | null>(null)
  const [out, setOut] = useState<{ kind: string; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (open && !cfg) api.aiConfig().then(setCfg).catch(() => setCfg({ configured: false, provider: 'anthropic', model: '' }))
  }, [open, cfg])

  const run = async (kind: 'summary' | 'trend') => {
    setBusy(kind)
    setOut(null)
    try {
      const res = kind === 'summary' ? await api.aiSummary() : await api.aiTrends()
      if (res.error) throw new Error(res.error)
      setOut({ kind, text: res.text! })
    } catch (e) {
      setOut({ kind, text: '⚠ ' + String((e as Error).message ?? e) })
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return (
    <>
      {/* scrim */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
      />
      {/* drawer */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <Sparkles size={18} style={{ color: 'var(--color-accent)' }} />
          <span className="font-medium">AI analysis</span>
          <button onClick={onClose} className="ml-auto text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-5">
          <p className="text-sm text-[var(--color-ink-dim)]">
            Opt-in, bring-your-own-key. KubeForge sends the <em>findings</em> — counts, titles,
            trends — to your model, never raw cluster objects or secrets.
          </p>

          {cfg && !cfg.configured && (
            <div className="mt-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
              <div className="mb-2 font-medium">Not configured yet</div>
              <p className="text-[var(--color-ink-dim)]">
                Add a provider and API key (Anthropic, or any OpenAI-compatible endpoint including a
                local Ollama) to enable analysis.
              </p>
              <button
                onClick={() => { onClose(); onGoInsights() }}
                className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black"
              >
                <Settings size={14} /> Set up in Insights
              </button>
            </div>
          )}

          {cfg?.configured && (
            <div className="mt-5 flex flex-col gap-2">
              <DrawerAction label="Summarize & prioritize findings" busy={busy === 'summary'} onClick={() => run('summary')} icon={Sparkles} />
              <DrawerAction label="Analyze trends over time" busy={busy === 'trend'} onClick={() => run('trend')} icon={TrendingUp} />
              <span className="text-[11px] text-[var(--color-ink-faint)]">
                model: <span className="mono">{cfg.model}</span>
              </span>
            </div>
          )}

          {out && (
            <div className="mt-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                {out.kind === 'summary' ? 'Priorities' : 'Trend analysis'}
              </div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">
                {out.text}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

function DrawerAction({ label, busy, onClick, icon: Icon }: {
  label: string
  busy: boolean
  onClick: () => void
  icon: typeof Sparkles
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-2 rounded-lg border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
    >
      <Icon size={15} />
      {busy ? 'thinking…' : label}
    </button>
  )
}
