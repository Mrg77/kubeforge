import { useEffect, useMemo, useState } from 'react'
import { api, type ResourceKind, type GenericObject } from '../api'
import { Card, Spinner, ErrorNote, cn } from '../lib'

// Resources: the universal browser. Lists EVERY kind the cluster exposes
// (built-ins and CRDs), so nothing on a self-managed cluster is invisible.
export function Resources() {
  const [kinds, setKinds] = useState<ResourceKind[] | null>(null)
  const [selected, setSelected] = useState<ResourceKind | null>(null)
  const [objs, setObjs] = useState<GenericObject[] | null>(null)
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.resourceKinds().then((k) => {
      setKinds(k)
      setSelected(k.find((x) => x.kind === 'Pod') ?? k[0] ?? null)
    }).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    setObjs(null)
    api.listResource(selected).then(setObjs).catch((e) => setErr(String(e.message ?? e)))
  }, [selected])

  const filtered = useMemo(() => {
    if (!kinds) return []
    const f = filter.toLowerCase()
    return kinds.filter((k) => k.kind.toLowerCase().includes(f) || k.group.toLowerCase().includes(f))
  }, [kinds, filter])

  if (err) return <ErrorNote message={err} />
  if (!kinds) return <Spinner />

  const builtins = filtered.filter((k) => !k.custom)
  const customs = filtered.filter((k) => k.custom)

  return (
    <div className="flex gap-6" style={{ height: 'calc(100vh - 8rem)' }}>
      {/* Kind list */}
      <Card className="flex w-64 shrink-0 flex-col overflow-hidden">
        <div className="border-b border-[var(--color-border)] p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter resources…"
            className="w-full rounded-md bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <KindGroup title="Built-in" kinds={builtins} selected={selected} onSelect={setSelected} />
          {customs.length > 0 && (
            <KindGroup title="Custom (CRDs)" kinds={customs} selected={selected} onSelect={setSelected} />
          )}
        </div>
        <div className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">
          {kinds.length} resource kinds discovered
        </div>
      </Card>

      {/* Objects of the selected kind */}
      <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <span className="text-sm font-medium">{selected?.kind ?? '—'}</span>
          {selected?.group && (
            <span className="text-xs text-[var(--color-ink-faint)] mono">{selected.group}/{selected.version}</span>
          )}
          {selected && (
            <span className="ml-auto text-xs text-[var(--color-ink-dim)]">
              {selected.namespaced ? 'namespaced' : 'cluster-scoped'}
              {objs && ` · ${objs.length}`}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!objs ? (
            <div className="p-5"><Spinner /></div>
          ) : objs.length === 0 ? (
            <div className="p-5 text-sm text-[var(--color-ink-dim)]">No {selected?.kind} objects.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  {selected?.namespaced && <th className="px-5 py-2 font-medium">Namespace</th>}
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-5 py-2 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {objs.map((o) => (
                  <tr
                    key={`${o.namespace}/${o.name}`}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                  >
                    {selected?.namespaced && (
                      <td className="px-5 py-2 text-[var(--color-ink-dim)] mono">{o.namespace}</td>
                    )}
                    <td className="px-5 py-2 mono">{o.name}</td>
                    <td className="px-5 py-2 text-[var(--color-ink-dim)] mono">{o.age}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  )
}

function KindGroup({
  title,
  kinds,
  selected,
  onSelect,
}: {
  title: string
  kinds: ResourceKind[]
  selected: ResourceKind | null
  onSelect: (k: ResourceKind) => void
}) {
  if (kinds.length === 0) return null
  return (
    <div className="mb-1">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">{title}</div>
      {kinds.map((k) => {
        const active = selected?.name === k.name && selected?.group === k.group
        return (
          <button
            key={`${k.group}/${k.version}/${k.name}`}
            onClick={() => onSelect(k)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
              active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-2)]',
            )}
            style={active ? { color: 'var(--color-accent)' } : undefined}
          >
            <span className="truncate">{k.kind}</span>
          </button>
        )
      })}
    </div>
  )
}
