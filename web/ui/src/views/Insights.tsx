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
  const { t, locale } = useT()
  const [showConfig, setShowConfig] = useState(!cfg.configured)
  const [summary, setSummary] = useState<string | null>(null)
  const [trend, setTrend] = useState<string | null>(null)
  const [busy, setBusy] = useState<'summary' | 'trend' | null>(null)

  const run = async (kind: 'summary' | 'trend') => {
    setBusy(kind)
    try {
      const res = kind === 'summary' ? await api.aiSummary(locale) : await api.aiTrends(locale)
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

// A Preset is one entry in the picker. `provider` is the backend format to use
// (anthropic/google have native shapes; everything else is OpenAI-compatible and
// just needs its baseUrl). `custom` lets the user point at any endpoint.
interface Preset {
  id: string
  label: string
  brand: string
  color: string
  provider: AIProvider // backend format
  baseUrl?: string // for OpenAI-compatible providers
  models: string[]
  keyURL?: string
  keyLabel?: string
  free?: boolean // offers a no-credit-card free tier — surfaced first
  custom?: boolean // free-form endpoint + model
}

// The catalog, ordered so the FREE options come first: most people have a chat
// subscription, not a paid API bill, so the AI must work without paying. Gemini
// and Groq hand out a free key (no card); Claude/ChatGPT/etc. need paid API
// credit. Claude & Gemini use native API shapes; the rest speak the OpenAI-
// compatible standard (one code path, differ only by baseUrl). "Custom" covers
// self-hosted (LiteLLM, vLLM, Ollama) and anything new.
const PRESETS: Preset[] = [
  { id: 'google', label: 'Gemini', brand: 'Google', color: '#4285f4', provider: 'google', free: true,
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyURL: 'https://aistudio.google.com/apikey', keyLabel: 'aistudio.google.com' },
  { id: 'groq', label: 'Groq', brand: 'fast, free tier', color: '#f55036', provider: 'openai', free: true,
    baseUrl: 'https://api.groq.com/openai', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    keyURL: 'https://console.groq.com/keys', keyLabel: 'console.groq.com' },
  { id: 'anthropic', label: 'Claude', brand: 'Anthropic', color: '#d97757', provider: 'anthropic',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    keyURL: 'https://console.anthropic.com/settings/keys', keyLabel: 'console.anthropic.com' },
  { id: 'openai', label: 'ChatGPT', brand: 'OpenAI', color: '#10a37f', provider: 'openai',
    baseUrl: 'https://api.openai.com', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    keyURL: 'https://platform.openai.com/api-keys', keyLabel: 'platform.openai.com' },
  { id: 'mistral', label: 'Mistral', brand: 'Mistral AI 🇫🇷', color: '#fa5310', provider: 'openai',
    baseUrl: 'https://api.mistral.ai', models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    keyURL: 'https://console.mistral.ai/api-keys', keyLabel: 'console.mistral.ai' },
  { id: 'deepseek', label: 'DeepSeek', brand: 'DeepSeek', color: '#4d6bfe', provider: 'openai',
    baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'],
    keyURL: 'https://platform.deepseek.com/api_keys', keyLabel: 'platform.deepseek.com' },
  { id: 'xai', label: 'Grok', brand: 'xAI', color: '#8f9aa8', provider: 'openai',
    baseUrl: 'https://api.x.ai', models: ['grok-4', 'grok-3', 'grok-3-mini'],
    keyURL: 'https://console.x.ai', keyLabel: 'console.x.ai' },
  { id: 'openrouter', label: 'OpenRouter', brand: '300+ models, 1 key', color: '#6467f2', provider: 'openai',
    baseUrl: 'https://openrouter.ai/api', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct'],
    keyURL: 'https://openrouter.ai/keys', keyLabel: 'openrouter.ai' },
  { id: 'custom', label: 'Custom', brand: 'any OpenAI-compatible endpoint', color: '#9aa7b4', provider: 'openai',
    baseUrl: '', models: [], custom: true },
]

const byId = (id: string) => PRESETS.find((p) => p.id === id)!

// Figure out which preset a saved config matches (for re-opening the form). A
// fresh, unconfigured install defaults to the first free provider (Gemini) so
// the suggested path costs nothing.
function presetFor(cfg: AIConfig): Preset {
  if (!cfg.configured && !cfg.model) return PRESETS.find((p) => p.free)!
  if (cfg.provider === 'anthropic') return byId('anthropic')
  if (cfg.provider === 'google') return byId('google')
  const byURL = PRESETS.find((p) => p.baseUrl && cfg.baseUrl && p.baseUrl === cfg.baseUrl)
  return byURL ?? byId('custom')
}

function ConfigForm({ cfg, onSaved }: { cfg: AIConfig; onSaved: (c: AIConfig) => void }) {
  const { t } = useT()
  const [preset, setPreset] = useState<Preset>(() => presetFor(cfg))
  const [model, setModel] = useState(cfg.model || presetFor(cfg).models[0] || '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? presetFor(cfg).baseUrl ?? '')
  const [busy, setBusy] = useState<'test' | 'save' | 'models' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  // Live models fetched from the provider (empty = fall back to preset defaults).
  const [liveModels, setLiveModels] = useState<string[] | null>(null)

  const provider = preset.provider
  // The list shown in the dropdown: real models once fetched, else preset seeds.
  const modelOptions = liveModels ?? preset.models

  const pickPreset = (p: Preset) => {
    setPreset(p)
    setModel(p.models[0] ?? '')
    setBaseUrl(p.baseUrl ?? '')
    setLiveModels(null)
    setResult(null)
  }

  // Turn a raw provider error into something actionable. The classic trap: a
  // chat subscription (Claude Max, ChatGPT Plus) does NOT fund the API — that's
  // a separate paid wallet — so "credit balance too low" confuses everyone.
  const friendlyError = (raw: string): string => {
    const low = raw.toLowerCase()
    if (low.includes('credit') || low.includes('quota') || low.includes('billing') || low.includes('insufficient')) {
      return t('ai.errCredit')
    }
    if (low.includes('invalid') && low.includes('key')) return t('ai.errKey')
    return raw
  }

  // Ask the provider which models this key can use, and populate the dropdown.
  const loadModels = async () => {
    setBusy('models'); setResult(null)
    try {
      const r = await api.aiModels({ provider, apiKey, baseUrl })
      if (r.error || !r.models?.length) {
        setResult({ ok: false, msg: friendlyError(r.error ?? 'no models returned') })
      } else {
        const sorted = [...r.models].sort()
        setLiveModels(sorted)
        if (!sorted.includes(model)) setModel(sorted[0])
        setResult({ ok: true, msg: t('ai.modelsLoaded', { n: sorted.length }) })
      }
    } catch (e) {
      setResult({ ok: false, msg: String((e as Error).message ?? e) })
    } finally { setBusy(null) }
  }

  const test = async () => {
    setBusy('test'); setResult(null)
    try {
      const r = await api.aiTest({ provider, model, apiKey, baseUrl })
      setResult(r.ok ? { ok: true, msg: t('ai.connected') } : { ok: false, msg: friendlyError(r.error ?? 'failed') })
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
      {/* free-first banner: the AI works without paying */}
      <div className="rounded-md px-3 py-2 text-xs"
        style={{ color: 'var(--color-ok)', background: 'color-mix(in srgb, var(--color-ok) 10%, transparent)' }}>
        💡 {t('ai.freeBanner')}
      </div>

      {/* provider picker — free options first, each badged */}
      <div>
        <div className="mb-2 text-xs text-[var(--color-ink-dim)]">{t('ai.chooseAI')}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {PRESETS.map((p) => {
            const on = preset.id === p.id
            return (
              <button key={p.id} onClick={() => pickPreset(p)}
                className="relative rounded-lg border p-2.5 text-left transition"
                style={{ borderColor: on ? p.color : 'var(--color-border)', background: on ? `color-mix(in srgb, ${p.color} 14%, transparent)` : 'var(--color-surface-2)' }}>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold" style={{ color: on ? p.color : 'var(--color-ink)' }}>{p.label}</span>
                  {p.free && (
                    <span className="rounded-full px-1.5 text-[9px] font-medium"
                      style={{ color: 'var(--color-ok)', background: 'color-mix(in srgb, var(--color-ok) 18%, transparent)' }}>
                      {t('ai.free')}
                    </span>
                  )}
                </div>
                <div className="truncate text-[10px] text-[var(--color-ink-faint)]">{p.brand}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 1) API key first — that's what unlocks the real model list */}
      <label className="text-sm">
        <span className="flex items-center justify-between text-[var(--color-ink-dim)]">
          {t('ai.apiKey')}
          {preset.keyURL && (
            <a href={preset.keyURL} target="_blank" rel="noopener"
              className="text-[11px] text-[var(--color-accent)] hover:underline">
              {t('ai.getKey')} {preset.keyLabel}
            </a>
          )}
        </span>
        <input type="password" value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setResult(null); setLiveModels(null) }}
          placeholder={cfg.configured ? t('ai.keyPlaceholderKeep') : t('ai.keyPlaceholderNew')}
          className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono" />
      </label>

      {/* 2) base URL for OpenAI-compatible / custom endpoints */}
      {provider === 'openai' && (
        <label className="text-sm">
          <span className="text-[var(--color-ink-dim)]">{t('ai.baseUrl')}</span>
          <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setResult(null); setLiveModels(null) }}
            placeholder="https://api.openai.com  ·  or your own endpoint"
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono" />
        </label>
      )}

      {/* 3) model — fetched live from the provider with the key above */}
      <label className="text-sm">
        <span className="flex items-center justify-between text-[var(--color-ink-dim)]">
          {t('ai.model')}
          <button onClick={loadModels} disabled={busy !== null || (!apiKey && !cfg.configured)}
            className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-40 disabled:no-underline">
            {busy === 'models' ? t('ai.loadingModels') : t('ai.loadModels')}
          </button>
        </span>
        {liveModels || !preset.custom ? (
          <select value={model} onChange={(e) => { setModel(e.target.value); setResult(null) }}
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono">
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input value={model} onChange={(e) => { setModel(e.target.value); setResult(null) }}
            placeholder="model-name — or click Load models"
            className="mt-1 w-full rounded-md bg-[var(--color-surface-2)] px-3 py-1.5 outline-none mono" />
        )}
        {!liveModels && (
          <span className="mt-1 block text-[10px] text-[var(--color-ink-faint)]">{t('ai.modelHint')}</span>
        )}
      </label>

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
