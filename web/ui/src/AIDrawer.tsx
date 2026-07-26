import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, Settings, Send } from 'lucide-react'
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

interface ChatMsg { role: 'user' | 'assistant'; text: string }

export function AIDrawer({ open, onClose, onGoInsights }: {
  open: boolean
  onClose: () => void
  onGoInsights: () => void
}) {
  const { t, locale } = useT()
  const [cfg, setCfg] = useState<AIConfig | null>(null)
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && !cfg) api.aiConfig().then(setCfg).catch(() => setCfg({ configured: false, provider: 'anthropic', model: '' }))
  }, [open, cfg])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy])

  // Suggested starter questions — the common DevOps asks, one click.
  const suggestions = [
    t('chat.q.summary'),
    t('chat.q.waste'),
    t('chat.q.unhealthy'),
    t('chat.q.arch'),
  ]

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const next = [...msgs, { role: 'user' as const, text: q }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    try {
      const res = await api.aiChat(next, locale)
      if (res.error) throw new Error(res.error)
      setMsgs([...next, { role: 'assistant', text: res.text! }])
    } catch (e) {
      setMsgs([...next, { role: 'assistant', text: '⚠ ' + String((e as Error).message ?? e) }])
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <Sparkles size={18} style={{ color: 'var(--color-accent)' }} />
          <span className="font-medium">{t('chat.title')}</span>
          {cfg?.configured && <span className="text-[11px] text-[var(--color-ink-faint)] mono">{cfg.model}</span>}
          {msgs.length > 0 && (
            <button onClick={() => setMsgs([])} className="ml-auto text-[11px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
              {t('chat.clear')}
            </button>
          )}
          <button onClick={onClose} className={msgs.length > 0 ? 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]' : 'ml-auto text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]'}>
            <X size={18} />
          </button>
        </header>

        {/* not configured → point to setup */}
        {cfg && !cfg.configured ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <Sparkles size={28} style={{ color: 'var(--color-accent)' }} />
            <div className="text-sm font-medium">{t('chat.notConfigured')}</div>
            <p className="text-xs text-[var(--color-ink-dim)]">{t('chat.notConfiguredSub')}</p>
            <button onClick={() => { onClose(); onGoInsights() }}
              className="mt-1 flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black">
              <Settings size={14} /> {t('chat.setup')}
            </button>
          </div>
        ) : (
          <>
            {/* conversation */}
            <div ref={scrollRef} className="flex-1 overflow-auto p-5">
              {msgs.length === 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-[var(--color-ink-dim)]">{t('chat.intro')}</p>
                  <div className="flex flex-col gap-2">
                    {suggestions.map((s) => (
                      <button key={s} onClick={() => send(s)}
                        className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-left text-sm text-[var(--color-ink-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]">
                        {s}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">{t('chat.privacy')}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {msgs.map((m, i) => (
                    <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                      <div className={m.role === 'user'
                        ? 'max-w-[85%] rounded-lg rounded-br-sm bg-[var(--color-accent-soft)] px-3 py-2 text-sm text-[var(--color-ink)]'
                        : 'max-w-[92%] whitespace-pre-wrap rounded-lg rounded-bl-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed text-[var(--color-ink)]'}>
                        {m.text}
                      </div>
                    </div>
                  ))}
                  {busy && <div className="text-xs text-[var(--color-ink-faint)]">{t('chat.thinking')}</div>}
                </div>
              )}
            </div>

            {/* input */}
            <div className="border-t border-[var(--color-border)] p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
                  rows={1}
                  placeholder={t('chat.placeholder')}
                  className="max-h-32 flex-1 resize-none rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none"
                />
                <button onClick={() => send(input)} disabled={busy || !input.trim()}
                  className="rounded-lg bg-[var(--color-accent)] p-2 text-black disabled:opacity-40">
                  <Send size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
