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

export interface TopoPod {
  name: string
  namespace: string
  healthy: boolean
  status: string
  owner: string
  ownerKind: string
}

export interface Topology {
  nodes: {
    name: string
    ready: boolean
    pods: TopoPod[]
  }[]
  services: { name: string; namespace: string; type: string; podKeys: string[] }[]
}

export interface GraphNode {
  id: string
  kind: string
  name: string
  layer: string
  healthy: boolean
  detail: string
  info?: { k: string; v: string }[]
  risk?: string[]
  custom?: boolean
}
export interface EventLine {
  type: string
  reason: string
  message: string
  count: number
  age: string
}
export interface GraphEdge {
  from: string
  to: string
  kind: string
}
export interface LayeredGraph {
  namespace: string
  layers: { id: string; label: string }[]
  nodes: GraphNode[]
  edges: GraphEdge[]
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
  code: string
  title: string
  object: string
  namespace?: string
  detail: string
  system: boolean
}

export interface SecReport {
  findings: SecFinding[]
  counts: { critical: number; high: number; medium: number; low: number; info: number }
  ownCounts: { critical: number; high: number; medium: number; low: number; info: number }
  scanned: { pods: number; namespaces: number; clusterRoleBindings: number }
}

export interface PodCost {
  name: string
  namespace: string
  owner: string
  ownerKind: string
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

export interface WorkloadCost {
  name: string
  namespace: string
  kind: string
  pods: number
  cpuRequest: number
  cpuUsage: number
  memRequestGB: number
  memUsageGB: number
  monthlyCost: number
  wastedMonthly: number
  level: 'ok' | 'moderate' | 'high' | 'unbounded'
}

export interface NamespaceCost {
  namespace: string
  monthlyCost: number
  wastedMonthly: number
  pods: number
}

export interface FinReport {
  pods: PodCost[]
  workloads: WorkloadCost[]
  namespaces: NamespaceCost[]
  totalMonthly: number
  wastedMonthly: number
  totalCpuReq: number
  totalCpuUsed: number
  totalMemReqGB: number
  totalMemUsedGB: number
  metricsAvailable: boolean
  prices: { PerCPUHour: number; PerGBHour: number }
  provider: {
    id: string
    label: string
    local: boolean
    region?: string
    instanceType?: string
  }
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
  cpuReserved: number
  cpuUsed: number
}

export type AIProvider = 'anthropic' | 'openai' | 'google'
export interface AIConfig {
  configured: boolean
  provider: AIProvider
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
  topology: (namespace?: string) =>
    get<Topology>('/api/topology' + (namespace ? `?namespace=${encodeURIComponent(namespace)}` : '')),
  namespaces: () => get<string[]>('/api/namespaces'),
  layers: (namespace: string) =>
    get<LayeredGraph>(`/api/layers?namespace=${encodeURIComponent(namespace)}`),
  objectYAML: (kind: string, namespace: string, name: string) =>
    get<{ yaml: string }>(
      `/api/object/yaml?kind=${encodeURIComponent(kind)}&namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
    ),
  objectEvents: (namespace: string, name: string) =>
    get<EventLine[]>(
      `/api/object/events?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
    ),
  resourceKinds: () => get<ResourceKind[]>('/api/resources'),
  listResource: (rk: ResourceKind, namespace?: string) => {
    const group = rk.group === '' ? 'core' : rk.group
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''
    return get<GenericObject[]>(`/api/resources/${group}/${rk.version}/${rk.name}${q}`)
  },
  secops: () => get<SecReport>('/api/secops'),
  finops: (prices?: { cpuHour: number; gbHour: number }) =>
    get<FinReport>(
      '/api/finops' +
        (prices ? `?cpuHour=${prices.cpuHour}&gbHour=${prices.gbHour}` : ''),
    ),
  storage: () => get<StorageReport>('/api/storage'),
  history: (since?: string) => get<Snapshot[]>('/api/history' + (since ? `?since=${since}` : '')),

  aiConfig: () => get<AIConfig>('/api/ai/config'),
  aiSaveConfig: (c: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    post<{ saved?: boolean; error?: string }>('/api/ai/config', c),
  aiTest: (c: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    post<{ ok: boolean; error?: string }>('/api/ai/test', c),
  aiSummary: () => post<{ text?: string; error?: string }>('/api/ai/summary'),
  aiTrends: () => post<{ text?: string; error?: string }>('/api/ai/trends'),
}
