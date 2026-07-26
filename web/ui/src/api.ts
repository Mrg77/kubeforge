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
}
