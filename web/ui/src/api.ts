// Typed client for the KubeForge Go backend. Keeps every fetch in one place and
// mirrors the JSON shapes the server emits (internal/api, internal/cluster).

export interface ClusterInfo {
  context: string
  server: string
  version: string
  reachable: boolean
  metricsAvailable: boolean
  error?: string
}

export interface Pod {
  name: string
  namespace: string
  node: string
  phase: string
  status: string
  ready: string
  restarts: number
  healthy: boolean
  age: string
}

export interface Node {
  name: string
  ready: boolean
  roles: string
  version: string
  age: string
}

export interface ResourceKind {
  group: string
  version: string
  kind: string
  name: string
  namespaced: boolean
  custom: boolean
  verbs: string[]
}

export interface GenericObject {
  name: string
  namespace?: string
  age: string
}

export interface SecFinding {
  category: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
  title: string
  object: string
  namespace?: string
  detail: string
}

export interface SecReport {
  findings: SecFinding[]
  counts: { critical: number; high: number; medium: number; low: number; info: number }
  scanned: { pods: number; namespaces: number; clusterRoleBindings: number }
}

export interface PodCost {
  name: string
  namespace: string
  cpuRequest: number
  cpuUsage: number
  memRequestGB: number
  memUsageGB: number
  level: 'ok' | 'moderate' | 'high' | 'unbounded'
  monthlyCost: number
  wastedMonthly: number
  recommendation: string
  hasMetrics: boolean
}

export interface NamespaceCost {
  namespace: string
  monthlyCost: number
  wastedMonthly: number
  pods: number
}

export interface FinReport {
  pods: PodCost[]
  namespaces: NamespaceCost[]
  totalMonthly: number
  wastedMonthly: number
  metricsAvailable: boolean
  prices: { perCPUHour: number; perGBHour: number }
}

export interface Snapshot {
  time: string
  pods: number
  unhealthy: number
  restarts: number
  secCritical: number
  secHigh: number
  secMedium: number
  monthlyReserved: number
  monthlyWasted: number
}

export interface AIConfig {
  configured: boolean
  provider: 'anthropic' | 'openai'
  model: string
  baseUrl?: string
}

export interface StorageReport {
  volumes: {
    name: string; capacityGB: number; phase: string; storageClass: string
    claim?: string; reclaimPolicy: string; orphaned: boolean; age: string
  }[]
  claims: {
    name: string; namespace: string; phase: string; capacityGB: number
    storageClass: string; volume?: string; unmounted: boolean; age: string
  }[]
  classes: { name: string; provisioner: string; default: boolean; reclaimPolicy: string; age: string }[]
  totalCapacityGB: number
  orphanedCapacityGB: number
  unmountedClaims: number
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json() as Promise<T>
}

export const api = {
  cluster: () => get<ClusterInfo>('/api/cluster'),
  pods: (namespace?: string) =>
    get<Pod[]>('/api/pods' + (namespace ? `?namespace=${encodeURIComponent(namespace)}` : '')),
  nodes: () => get<Node[]>('/api/nodes'),
  resourceKinds: () => get<ResourceKind[]>('/api/resources'),
  listResource: (rk: ResourceKind, namespace?: string) => {
    const group = rk.group === '' ? 'core' : rk.group
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''
    return get<GenericObject[]>(`/api/resources/${group}/${rk.version}/${rk.name}${q}`)
  },
  secops: () => get<SecReport>('/api/secops'),
  finops: () => get<FinReport>('/api/finops'),
  storage: () => get<StorageReport>('/api/storage'),
  history: (since?: string) => get<Snapshot[]>('/api/history' + (since ? `?since=${since}` : '')),

  aiConfig: () => get<AIConfig>('/api/ai/config'),
  aiSaveConfig: (c: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    post<{ saved?: boolean; error?: string }>('/api/ai/config', c),
  aiSummary: () => post<{ text?: string; error?: string }>('/api/ai/summary'),
  aiTrends: () => post<{ text?: string; error?: string }>('/api/ai/trends'),
}
