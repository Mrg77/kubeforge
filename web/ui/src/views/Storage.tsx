import { useEffect, useState } from 'react'
import { api, type StorageReport } from '../api'
import { Card, Stat, Spinner, ErrorNote } from '../lib'
import { useT } from '../i18n'

// ~$/GB-month for provisioned block storage — same order of magnitude the FinOps
// PVC cost uses, so the two views agree. Rough, for ranking not billing.
const GB_MONTH = 0.1

// Storage: the pillar most dashboards skip. PV / PVC / StorageClass, with the
// waste that hides in them called out — orphaned volumes and unmounted claims,
// now costed so wasted storage shows up as dollars.
export function Storage() {
  const { t } = useT()
  const [rep, setRep] = useState<StorageReport | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.storage().then(setRep).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <ErrorNote message={err} />
  if (!rep) return <Spinner />

  const monthly = rep.totalCapacityGB * GB_MONTH
  const orphanCost = rep.orphanedCapacityGB * GB_MONTH

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label={t('sto.capacity')} value={`${rep.totalCapacityGB} GB`} hint={t('sto.volumes', { n: rep.volumes.length })} />
        <Stat label={t('fin.estCostMo')} value={`$${round0(monthly)}`} hint={`~$${GB_MONTH}/GB·mo`} />
        <Stat
          label={t('sto.orphaned')}
          value={`${rep.orphanedCapacityGB} GB`}
          tone={rep.orphanedCapacityGB > 0 ? 'warn' : 'ok'}
          hint={orphanCost > 0 ? t('sto.wastedMo', { n: round0(orphanCost) }) : t('sto.orphanedHint')}
        />
        <Stat
          label={t('sto.unmounted')}
          value={rep.unmountedClaims}
          tone={rep.unmountedClaims > 0 ? 'warn' : 'ok'}
          hint={t('sto.unmountedHint')}
        />
        <Stat label={t('sto.classes')} value={rep.classes.length} />
      </div>

      <Panel title={`Persistent Volumes (${rep.volumes.length})`}>
        {rep.volumes.length === 0 ? (
          <Empty text="No PersistentVolumes." />
        ) : (
          <Table
            head={['Volume', 'Capacity', 'Phase', 'Class', 'Claim', 'Reclaim', 'Age']}
            rows={rep.volumes.map((v) => ({
              key: v.name,
              warn: v.orphaned,
              cells: [
                v.name,
                `${v.capacityGB} GB`,
                <Phase key="p" value={v.phase} warn={v.orphaned} />,
                v.storageClass || '—',
                v.claim || '—',
                v.reclaimPolicy,
                v.age,
              ],
            }))}
          />
        )}
      </Panel>

      <Panel title={`Persistent Volume Claims (${rep.claims.length})`}>
        {rep.claims.length === 0 ? (
          <Empty text="No PersistentVolumeClaims." />
        ) : (
          <Table
            head={['Namespace', 'Claim', 'Phase', 'Capacity', 'Class', 'Age']}
            rows={rep.claims.map((c) => ({
              key: `${c.namespace}/${c.name}`,
              warn: c.unmounted || c.phase === 'Pending',
              cells: [
                c.namespace,
                <span key="n">
                  {c.name}
                  {c.unmounted && (
                    <span className="ml-2 rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--color-warn)', background: 'var(--color-warn)1a' }}>
                      unmounted
                    </span>
                  )}
                </span>,
                <Phase key="p" value={c.phase} warn={c.phase !== 'Bound'} />,
                `${c.capacityGB} GB`,
                c.storageClass || '—',
                c.age,
              ],
            }))}
          />
        )}
      </Panel>

      <Panel title={`Storage Classes (${rep.classes.length})`}>
        <Table
          head={['Name', 'Provisioner', 'Reclaim', 'Default', 'Age']}
          rows={rep.classes.map((c) => ({
            key: c.name,
            cells: [c.name, c.provisioner, c.reclaimPolicy || '—', c.default ? '✓' : '', c.age],
          }))}
        />
      </Panel>
    </div>
  )
}

function Phase({ value, warn }: { value: string; warn?: boolean }) {
  const color = warn ? 'var(--color-warn)' : 'var(--color-ok)'
  return (
    <span className="mono" style={{ color }}>
      {value}
    </span>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="border-b border-[var(--color-border)] px-5 py-3 text-sm font-medium">{title}</div>
      {children}
    </Card>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="p-5 text-sm text-[var(--color-ink-dim)]">{text}</div>
}

function Table({
  head,
  rows,
}: {
  head: string[]
  rows: { key: string; warn?: boolean; cells: React.ReactNode[] }[]
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
            {head.map((h) => (
              <th key={h} className="px-5 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
              {r.cells.map((c, i) => (
                <td key={i} className="px-5 py-2 mono">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function round0(n: number) { return Math.round(n) }
