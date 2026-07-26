import { useEffect, useState } from 'react'
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Sparkles, TrendingUp, Settings } from 'lucide-react'
import { api, type Snapshot, type AIConfig, type AIProvider } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'
import { useT } from '../i18n'

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
  const { t } = useT()
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
        <span className="font-medium">{t('ai.title')}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{
            color: cfg.configured ? 'var(--color-ok)' : 'var(--color-ink-faint)',
            background: cfg.configured ? 'var(--color-ok)1a' : 'transparent',
          }}
        >
          {cfg.configured ? t('ai.ready') : t('ai.notConfigured')}
        </span>
        <button
          onClick={() => setShowConfig((v) => !v)}
          className="ml-auto flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
        >
          <Settings size={13} /> {t('ai.settings')}
        </button>
      </div>

      <p className="mt-1 text-sm text-[var(--color-ink-dim)]">{t('ai.blurb')}</p>

      {showConfig && <ConfigForm cfg={cfg} onSaved={(c) => { onConfig(c); setShowConfig(!c.configured) }} />}

      {cfg.configured && (
        <div className="mt-4 flex flex-wrap gap-3">
          <ActionButton
            icon={Sparkles}
            label={t('ai.summarize')}
            busy={busy === 'summary'}
            onClick={() => run('summary')}
          />
          <ActionButton
            icon={TrendingUp}
            label={t('ai.analyzeTrends')}
            busy={busy === 'trend'}
            disabled={!hasHistory}
            hint={!hasHistory ? t('ai.needHistory') : undefined}
            onClick={() => run('trend')}
          />
        </div>
      )}

      {summary && <AIOutput title={t('ai.priorities')} text={summary} />}
      {trend && <AIOutput title={t('ai.trendAnalysis')} text={trend} />}
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
  const { t } = useT()
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
      {busy ? t('ai.thinking') : label}
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

// PROVIDERS is the catalog powering the picker: brand, pre-filled models (so
// nobody types a model name), and a direct link to create a key.
const PROVIDERS: Record<AIProvider, {
  label: string; brand: string; color: string; models: string[]; keyURL: string; keyLabel: string
}> = {
  anthropic: {
    label: 'Claude', brand: 'Anthropic', color: '#d97757',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    keyURL: 'https://console.anthropic.com/settings/keys', keyLabel: 'console.anthropic.com',
  },
  openai: {
    label: 'ChatGPT', brand: 'OpenAI', color: '#10a37f',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    keyURL: 'https://platform.openai.com/api-keys', keyLabel: 'platform.openai.com',
  },
  google: {
    label: 'Gemini', brand: 'Google', color: '#4285f4',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    keyURL: 'https://aistudio.google.com/apikey', keyLabel: 'aistudio.google.com',
  },
}

function ConfigForm({ cfg, onSaved }: { cfg: AIConfig; onSaved: (c: AIConfig) => void }) {
  const { t } = useT()
  const [provider, setProvider] = useState<AIProvider>(cfg.provider || 'anthropic')
  const [model, setModel] = useState(cfg.model || PROVIDERS.anthropic.models[0])
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? '')
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const meta = PROVIDERS[provider]

  const pickProvider = (p: AIProvider) => {
    setProvider(p)
    setModel(PROVIDERS[p].models[0]) // sensible default model for that brand
    setResult(null)
  }

  const test = async () => {
    setBusy('test'); setResult(null)
    try {
      const r = await api.aiTest({ provider, model, apiKey, baseUrl })
      setResult(r.ok ? { ok: true, msg: t('ai.connected') } : { ok: false, msg: r.error ?? 'failed' })
    } catch (e) {
      setResult({ ok: false, msg: String((e as Error).message ?? e) })
    } finally { setBusy(null) }
  }

  const save = async () => {
    setBusy('save')
    try {
      await api.aiSaveConfig({ provider, model, apiKey, baseUrl })
      const fresh = await api.aiConfig()
      onSaved(fresh)
    } finally { setBusy(null) }
  }

  return (
    <div className="mt-4 flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      {/* provider picker */}
      <div>
        <div className="mb-2 text-xs text-[var(--color-ink-dim)]">{t('ai.chooseAI')}</div>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(PROVIDERS) as AIProvider[]).map((p) => {
            const m = PROVIDERS[p]
            const on = provider === p
            return (
              <button key={p} onClick={() => pickProvider(p)}
                className="rounded-lg border p-3 text-left transition"
                style={{ borderColor: on ? m.color : 'var(--color-border)', background: on ? `color-mix(in srgb, ${m.color} 12%, transparent)` : 'var(--color-surface-2)' }}>
                <div className="text-sm font-semibold" style={{ color: on ? m.color : 'var(--color-ink)' }}>{m.label}</div>
                <div className="text-[11px] text-[var(--color-ink-faint)]">{m.brand}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="text-[var(--color-ink-dim)]">{t('ai.model')}</span>
          <select value={model} onChange={(e) => { setModel(e.target.value); setResult(null) }}
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono">
            {meta.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="flex items-center justify-between text-[var(--color-ink-dim)]">
            {t('ai.apiKey')}
            <a href={meta.keyURL} target="_blank" rel="noopener"
              className="text-[11px] text-[var(--color-accent)] hover:underline">
              {t('ai.getKey')} {meta.keyLabel}
            </a>
          </span>
          <input type="password" value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setResult(null) }}
            placeholder={cfg.configured ? t('ai.keyPlaceholderKeep') : t('ai.keyPlaceholderNew')}
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono" />
        </label>
      </div>

      {provider === 'openai' && (
        <label className="text-sm">
          <span className="text-[var(--color-ink-dim)]">{t('ai.baseUrl')}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com"
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono" />
        </label>
      )}

      {/* result banner */}
      {result && (
        <div className="rounded-md px-3 py-2 text-xs"
          style={{
            color: result.ok ? 'var(--color-ok)' : 'var(--color-crit)',
            background: `color-mix(in srgb, ${result.ok ? 'var(--color-ok)' : 'var(--color-crit)'} 12%, transparent)`,
          }}>
          {result.ok ? '✓ ' : '✕ '}{result.msg}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={test} disabled={busy !== null || !model}
          className="rounded-lg border border-[var(--color-border)] px-4 py-1.5 text-sm text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
          {busy === 'test' ? t('ai.testing') : t('ai.testConn')}
        </button>
        <button onClick={save} disabled={busy !== null || !model}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-black disabled:opacity-50">
          {busy === 'save' ? t('ai.saving') : t('ai.save')}
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
    // CPU band: reserved is the ceiling, used is the floor; the shaded gap
    // between them is idle capacity you pay for. Rounded to 0.01 core.
    cpuReserved: Math.round(s.cpuReserved * 100) / 100,
    cpuUsed: Math.round(s.cpuUsed * 100) / 100,
    cpuGap: Math.round((s.cpuReserved - s.cpuUsed) * 100) / 100,
  }))
  const hasCPU = data.some((d) => d.cpuReserved > 0)

  return (
    <div className="flex flex-col gap-6">
      {hasCPU && <ReservedVsUsedBand data={data} />}
      <div className="grid gap-6 lg:grid-cols-2">
      <TrendCard title="Cost over time ($/mo)">
        <LineChart data={data}>
          <XAxis dataKey="t" stroke="var(--color-ink-faint)" fontSize={10} />
          <YAxis stroke="var(--color-ink-faint)" fontSize={10} />
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="reserved" stroke="var(--color-info)" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line type="monotone" dataKey="wasted" stroke="var(--color-warn)" dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </TrendCard>
      <TrendCard title="Security findings over time">
        <LineChart data={data}>
          <XAxis dataKey="t" stroke="var(--color-ink-faint)" fontSize={10} />
          <YAxis stroke="var(--color-ink-faint)" fontSize={10} allowDecimals={false} />
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="critical" stroke="var(--color-crit)" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line type="monotone" dataKey="high" stroke="var(--color-warn)" dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </TrendCard>
      </div>
    </div>
  )
}

// ReservedVsUsedBand is the signature trend chart: reserved CPU as the outer
// band, used CPU stacked below it, so the shaded space in between is exactly the
// idle capacity you're paying for — drawn widening when waste creeps in and
// closing when a right-size lands. This is the picture k9s and Lens can't draw:
// they have no memory. Stacked areas (used + gap) so the top edge is `reserved`.
function ReservedVsUsedBand({ data }: { data: Record<string, number | string>[] }) {
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-sm font-medium">CPU reserved vs. used (cores)</div>
        <div className="text-xs text-[var(--color-ink-faint)]">
          shaded gap = idle capacity you pay for
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="usedFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-ok)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--color-ok)" stopOpacity={0.15} />
            </linearGradient>
            <linearGradient id="gapFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-warn)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-warn)" stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" stroke="var(--color-ink-faint)" fontSize={10} />
          <YAxis stroke="var(--color-ink-faint)" fontSize={10} />
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {/* Stack order: used (floor) then gap; the top of the stack = reserved. */}
          <Area
            type="monotone" dataKey="cpuUsed" name="used" stackId="cpu"
            stroke="var(--color-ok)" strokeWidth={2} fill="url(#usedFill)" isAnimationActive={false}
          />
          <Area
            type="monotone" dataKey="cpuGap" name="idle (reserved − used)" stackId="cpu"
            stroke="var(--color-warn)" strokeWidth={1} fill="url(#gapFill)" isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
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
