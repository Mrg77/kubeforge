import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Sparkles, TrendingUp, Settings } from 'lucide-react'
import { api, type Snapshot, type AIConfig } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'

// Insights: the trends-over-time charts (always available, deterministic) plus
// the opt-in AI layer (bring-your-own-key) that summarizes and analyzes them.
export function Insights() {
  const [history, setHistory] = useState<Snapshot[] | null>(null)
  const [cfg, setCfg] = useState<AIConfig | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.history('30d').then(setHistory).catch((e) => setErr(String(e.message ?? e)))
    api.aiConfig().then(setCfg).catch(() => setCfg({ configured: false, provider: 'anthropic', model: '' }))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!history || !cfg) return <Spinner />

  return (
    <div className="flex flex-col gap-6">
      <AIPanel cfg={cfg} onConfig={setCfg} hasHistory={history.length >= 2} />
      <TrendCharts history={history} />
    </div>
  )
}

// ---- AI panel: config + summary/trends actions ----------------------------

function AIPanel({
  cfg,
  onConfig,
  hasHistory,
}: {
  cfg: AIConfig
  onConfig: (c: AIConfig) => void
  hasHistory: boolean
}) {
  const [showConfig, setShowConfig] = useState(!cfg.configured)
  const [summary, setSummary] = useState<string | null>(null)
  const [trend, setTrend] = useState<string | null>(null)
  const [busy, setBusy] = useState<'summary' | 'trend' | null>(null)

  const run = async (kind: 'summary' | 'trend') => {
    setBusy(kind)
    try {
      const res = kind === 'summary' ? await api.aiSummary() : await api.aiTrends()
      if (res.error) throw new Error(res.error)
      kind === 'summary' ? setSummary(res.text!) : setTrend(res.text!)
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      kind === 'summary' ? setSummary('⚠ ' + msg) : setTrend('⚠ ' + msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Sparkles size={18} style={{ color: 'var(--color-accent)' }} />
        <span className="font-medium">AI analysis</span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{
            color: cfg.configured ? 'var(--color-ok)' : 'var(--color-ink-faint)',
            background: cfg.configured ? 'var(--color-ok)1a' : 'transparent',
          }}
        >
          {cfg.configured ? 'ready' : 'not configured'}
        </span>
        <button
          onClick={() => setShowConfig((v) => !v)}
          className="ml-auto flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
        >
          <Settings size={13} /> settings
        </button>
      </div>

      <p className="mt-1 text-sm text-[var(--color-ink-dim)]">
        Opt-in, bring-your-own-key. KubeForge sends the <em>findings</em> (counts, titles, trends) to
        your model — never raw cluster objects or secrets. Everything else works without it.
      </p>

      {showConfig && <ConfigForm cfg={cfg} onSaved={(c) => { onConfig(c); setShowConfig(!c.configured) }} />}

      {cfg.configured && (
        <div className="mt-4 flex flex-wrap gap-3">
          <ActionButton
            icon={Sparkles}
            label="Summarize & prioritize"
            busy={busy === 'summary'}
            onClick={() => run('summary')}
          />
          <ActionButton
            icon={TrendingUp}
            label="Analyze trends"
            busy={busy === 'trend'}
            disabled={!hasHistory}
            hint={!hasHistory ? 'needs more history' : undefined}
            onClick={() => run('trend')}
          />
        </div>
      )}

      {summary && <AIOutput title="Priorities" text={summary} />}
      {trend && <AIOutput title="Trend analysis" text={trend} />}
    </Card>
  )
}

function ActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  hint,
  onClick,
}: {
  icon: typeof Sparkles
  label: string
  busy: boolean
  disabled?: boolean
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title={hint}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
        disabled
          ? 'border-[var(--color-border)] text-[var(--color-ink-faint)] cursor-not-allowed'
          : 'border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]',
      )}
    >
      <Icon size={15} />
      {busy ? 'thinking…' : label}
    </button>
  )
}

function AIOutput({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{title}</div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-ink)]">{text}</div>
    </div>
  )
}

function ConfigForm({ cfg, onSaved }: { cfg: AIConfig; onSaved: (c: AIConfig) => void }) {
  const [provider, setProvider] = useState(cfg.provider)
  const [model, setModel] = useState(cfg.model || 'claude-haiku-4-5-20251001')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.aiSaveConfig({ provider, model, apiKey, baseUrl })
      const fresh = await api.aiConfig()
      onSaved(fresh)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 md:grid-cols-2">
      <label className="text-sm">
        <span className="text-[var(--color-ink-dim)]">Provider</span>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as AIConfig['provider'])}
          className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none"
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI-compatible (incl. Ollama)</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="text-[var(--color-ink-dim)]">Model</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono"
        />
      </label>
      <label className="text-sm md:col-span-2">
        <span className="text-[var(--color-ink-dim)]">API key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="stored locally, never sent to the browser again"
          className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono"
        />
      </label>
      {provider === 'openai' && (
        <label className="text-sm md:col-span-2">
          <span className="text-[var(--color-ink-dim)]">Base URL (optional — e.g. http://localhost:11434/v1 for Ollama)</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono"
          />
        </label>
      )}
      <div className="md:col-span-2">
        <button
          onClick={save}
          disabled={saving || !model}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50"
        >
          {saving ? 'saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ---- Trend charts (deterministic, always available) -----------------------

function TrendCharts({ history }: { history: Snapshot[] }) {
  if (history.length < 2) {
    return (
      <Card className="p-6 text-sm text-[var(--color-ink-dim)]">
        Trends appear here as KubeForge records snapshots over time (one every few minutes while it
        runs). Keep it running and check back.
      </Card>
    )
  }
  const data = history.map((s) => ({
    t: s.time.slice(5, 16).replace('T', ' '),
    wasted: Math.round(s.monthlyWasted),
    reserved: Math.round(s.monthlyReserved),
    critical: s.secCritical,
    high: s.secHigh,
    unhealthy: s.unhealthy,
  }))

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <TrendCard title="Cost over time ($/mo)">
        <LineChart data={data}>
          <XAxis dataKey="t" stroke="var(--color-ink-faint)" fontSize={10} />
          <YAxis stroke="var(--color-ink-faint)" fontSize={10} />
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="reserved" stroke="var(--color-info)" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="wasted" stroke="var(--color-warn)" dot={false} strokeWidth={2} />
        </LineChart>
      </TrendCard>
      <TrendCard title="Security findings over time">
        <LineChart data={data}>
          <XAxis dataKey="t" stroke="var(--color-ink-faint)" fontSize={10} />
          <YAxis stroke="var(--color-ink-faint)" fontSize={10} allowDecimals={false} />
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="critical" stroke="var(--color-crit)" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="high" stroke="var(--color-warn)" dot={false} strokeWidth={2} />
        </LineChart>
      </TrendCard>
    </div>
  )
}

const tooltip = {
  contentStyle: {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    color: 'var(--color-ink)',
  },
}

function TrendCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <Card className="p-5">
      <div className="mb-4 text-sm font-medium">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        {children}
      </ResponsiveContainer>
    </Card>
  )
}
