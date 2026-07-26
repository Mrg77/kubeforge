import { createContext, useContext, useState, type ReactNode } from 'react'

// Lightweight i18n: a flat key→string dictionary per locale, a context that
// holds the active locale (persisted, browser-detected on first run), and a
// useT() hook returning a t(key, vars?) function. No external dependency.

export type Locale = 'en' | 'fr'

// The dictionaries. Keys are dotted namespaces; English is the source of truth.
// Missing French keys fall back to English so the app never shows a raw key.
const EN: Record<string, string> = {
  // nav / chrome
  'nav.overview': 'Overview',
  'nav.topology': 'Topology',
  'nav.resources': 'Resources',
  'nav.storage': 'Storage',
  'nav.finops': 'FinOps',
  'nav.secops': 'SecOps',
  'nav.insights': 'Insights',
  'chrome.localFirst': 'local-first · nothing exposed',
  'chrome.refresh': 'refresh',
  'chrome.askAI': 'Ask AI',
  'chrome.setup': 'setup',
  'chrome.unreachable': 'unreachable',
  'chrome.connecting': 'connecting…',

  // overview
  'ov.finops': 'FinOps',
  'ov.finops.sub': 'estimated waste',
  'ov.secops': 'SecOps',
  'ov.secops.sub': 'critical + high findings',
  'ov.storage': 'Storage',
  'ov.storage.sub': '{n} GB orphaned',
  'ov.topology': 'Topology',
  'ov.topology.sub': 'explore the resource stack',
  'ov.pods': 'Pods',
  'ov.healthy': '{n} healthy',
  'ov.unhealthy': 'Unhealthy',
  'ov.needAttention': 'need attention',
  'ov.allGood': 'all good',
  'ov.nodes': 'Nodes',
  'ov.ready': 'ready',
  'ov.restarts': 'Restarts',
  'ov.acrossPods': 'across all pods',
  'ov.needsAttention': 'Needs attention',
  'ov.allPods': 'All pods',
  'col.namespace': 'Namespace',
  'col.pod': 'Pod',
  'col.status': 'Status',
  'col.ready': 'Ready',
  'col.restarts': 'Restarts',
  'col.age': 'Age',

  // topology
  'topo.lens.layered': 'Resource stack',
  'topo.lens.namespace': 'Namespaces',
  'topo.lens.graph': 'Workload graph',
  'topo.lens.node': 'By node',
  'topo.lens.heatmap': 'Heatmap',
  'topo.nodes': '{n} nodes',
  'topo.node': '{n} node',
  'topo.pods': '{n} pods',
  'topo.unhealthy': '{n} unhealthy',
  'topo.namespace': 'namespace',
  'topo.stackHint': 'traffic in at the top · config, identity & storage at the bottom',
  'topo.empty': 'Nothing to show — {ns} has no workloads or resources yet.',
  'topo.tab.detail': 'detail',
  'topo.tab.events': 'events',
  'topo.tab.manifest': 'manifest',
  'topo.noEvents': 'No recent events for this object.',
  'topo.noDetail': 'No extra detail for this kind.',
  'topo.secWarnings': 'SecOps warnings',

  // finops
  'fin.reservedMo': 'Reserved / mo',
  'fin.estimated': 'estimated',
  'fin.wastedMo': 'Wasted / mo',
  'fin.ofReserved': '{n}% of reserved',
  'fin.overProvisioned': 'Workloads over-provisioned',
  'fin.highWaste': 'high waste',
  'fin.efficiency': 'Cluster efficiency',
  'fin.cpuUsed': 'CPU used',
  'fin.effExplain': 'of reserved CPU is actually used.',
  'fin.effRest': "The rest is capacity you pay for and don't use.",
  'fin.pricing': 'Pricing',
  'fin.detected': 'detected',
  'fin.localEstimate': 'local cluster — estimate only, no real billing',
  'fin.auto': 'auto',
  'fin.costMap': 'Cost map — spend by namespace',
  'fin.costMapSub': 'Size = $/mo reserved · color = share wasted',
  'fin.topWasters': 'Top wasters',
  'fin.topWastersSub': 'Workloads reserving the most they never use — right-size these first',
  'fin.noWaste': 'No measurable waste — nicely sized.',
  'fin.costByWorkload': 'Cost by workload',
  'fin.costByWorkloadSub': '{n} workloads · click to expand replicas',
  'fin.allNamespaces': 'all namespaces',
  'fin.search': 'search…',
  'fin.col.workload': 'Workload',
  'fin.col.pods': 'Pods',
  'fin.col.cpu': 'CPU used/req',
  'fin.col.mem': 'Mem used/req',
  'fin.col.waste': 'Waste',
  'fin.col.cost': '$/mo cost',
  'fin.col.wasted': '$/mo wasted',
  'fin.noMetrics': "metrics-server isn't installed, so real usage is unknown. Costs reflect what pods reserve, but the reserved-vs-used waste gap can't be computed.",
  'fin.estCostMo': 'Est. cost / mo',
  'waste.ok': 'ok',
  'waste.moderate': 'moderate',
  'waste.high': 'high',
  'waste.unbounded': 'no limits',

  // secops
  'sec.postureScore': 'Posture score',
  'sec.postureSub': 'Weighted by severity across {n} pods scanned.',
  'sec.fixFirst': 'Fix criticals first to move the needle.',
  'sec.critical': 'Critical',
  'sec.high': 'High',
  'sec.medium': 'Medium',
  'sec.low': 'Low',
  'sec.searchFindings': 'search findings…',
  'sec.noMatch': '✓ No findings match these filters.',
  'sec.viewInStack': 'view in stack →',
  'sec.disclaimer': 'Deterministic posture scan — how things are configured, not runtime threat detection. A clean report means "no misconfiguration we check for", not "provably secure".',

  // storage
  'sto.capacity': 'Capacity',
  'sto.volumes': '{n} volumes',
  'sto.orphaned': 'Orphaned',
  'sto.orphanedHint': 'released / unbound',
  'sto.wastedMo': '~${n}/mo wasted',
  'sto.unmounted': 'Unmounted PVCs',
  'sto.unmountedHint': 'bound, nothing uses them',
  'sto.classes': 'Storage classes',

  // common
  'common.loading': 'loading',
}

const FR: Record<string, string> = {
  'nav.overview': "Vue d'ensemble",
  'nav.topology': 'Topologie',
  'nav.resources': 'Ressources',
  'nav.storage': 'Stockage',
  'nav.finops': 'FinOps',
  'nav.secops': 'SecOps',
  'nav.insights': 'Analyses',
  'chrome.localFirst': 'local-first · rien d\'exposé',
  'chrome.refresh': 'rafraîchir',
  'chrome.askAI': "Demander à l'IA",
  'chrome.setup': 'à configurer',
  'chrome.unreachable': 'injoignable',
  'chrome.connecting': 'connexion…',

  'ov.finops': 'FinOps',
  'ov.finops.sub': 'gaspillage estimé',
  'ov.secops': 'SecOps',
  'ov.secops.sub': 'findings critiques + élevés',
  'ov.storage': 'Stockage',
  'ov.storage.sub': '{n} Go orphelins',
  'ov.topology': 'Topologie',
  'ov.topology.sub': 'explorer le resource stack',
  'ov.pods': 'Pods',
  'ov.healthy': '{n} en bonne santé',
  'ov.unhealthy': 'En panne',
  'ov.needAttention': 'à surveiller',
  'ov.allGood': 'tout va bien',
  'ov.nodes': 'Nodes',
  'ov.ready': 'prêts',
  'ov.restarts': 'Redémarrages',
  'ov.acrossPods': 'tous pods confondus',
  'ov.needsAttention': 'À surveiller',
  'ov.allPods': 'Tous les pods',
  'col.namespace': 'Namespace',
  'col.pod': 'Pod',
  'col.status': 'Statut',
  'col.ready': 'Prêt',
  'col.restarts': 'Redémarrages',
  'col.age': 'Âge',

  'topo.lens.layered': 'Resource stack',
  'topo.lens.namespace': 'Namespaces',
  'topo.lens.graph': 'Graphe de workloads',
  'topo.lens.node': 'Par node',
  'topo.lens.heatmap': 'Heatmap',
  'topo.nodes': '{n} nodes',
  'topo.node': '{n} node',
  'topo.pods': '{n} pods',
  'topo.unhealthy': '{n} en panne',
  'topo.namespace': 'namespace',
  'topo.stackHint': 'le trafic entre en haut · config, identité & stockage en bas',
  'topo.empty': "Rien à afficher — {ns} n'a pas encore de workloads ni de ressources.",
  'topo.tab.detail': 'détail',
  'topo.tab.events': 'events',
  'topo.tab.manifest': 'manifeste',
  'topo.noEvents': 'Aucun event récent pour cet objet.',
  'topo.noDetail': 'Pas de détail supplémentaire pour ce type.',
  'topo.secWarnings': 'Alertes SecOps',

  'fin.reservedMo': 'Réservé / mois',
  'fin.estimated': 'estimé',
  'fin.wastedMo': 'Gaspillé / mois',
  'fin.ofReserved': '{n}% du réservé',
  'fin.overProvisioned': 'Workloads sur-provisionnés',
  'fin.highWaste': 'gaspillage élevé',
  'fin.efficiency': 'Efficacité du cluster',
  'fin.cpuUsed': 'CPU utilisé',
  'fin.effExplain': 'du CPU réservé est réellement utilisé.',
  'fin.effRest': 'Le reste est de la capacité que vous payez sans l\'utiliser.',
  'fin.pricing': 'Tarification',
  'fin.detected': 'détecté',
  'fin.localEstimate': 'cluster local — estimation seulement, pas de facturation réelle',
  'fin.auto': 'auto',
  'fin.costMap': 'Carte des coûts — dépense par namespace',
  'fin.costMapSub': 'Taille = $/mois réservé · couleur = part gaspillée',
  'fin.topWasters': 'Plus gros gaspillages',
  'fin.topWastersSub': "Workloads qui réservent le plus sans l'utiliser — à right-sizer en premier",
  'fin.noWaste': 'Aucun gaspillage mesurable — bien dimensionné.',
  'fin.costByWorkload': 'Coût par workload',
  'fin.costByWorkloadSub': '{n} workloads · cliquez pour déplier les replicas',
  'fin.allNamespaces': 'tous les namespaces',
  'fin.search': 'rechercher…',
  'fin.col.workload': 'Workload',
  'fin.col.pods': 'Pods',
  'fin.col.cpu': 'CPU util./rés.',
  'fin.col.mem': 'Mém. util./rés.',
  'fin.col.waste': 'Gaspillage',
  'fin.col.cost': '$/mois coût',
  'fin.col.wasted': '$/mois gaspillé',
  'fin.noMetrics': "metrics-server n'est pas installé, l'usage réel est inconnu. Les coûts reflètent ce que les pods réservent, mais l'écart réservé-vs-utilisé ne peut pas être calculé.",
  'fin.estCostMo': 'Coût est. / mois',
  'waste.ok': 'ok',
  'waste.moderate': 'modéré',
  'waste.high': 'élevé',
  'waste.unbounded': 'sans limites',

  'sec.postureScore': 'Score de posture',
  'sec.postureSub': 'Pondéré par sévérité sur {n} pods scannés.',
  'sec.fixFirst': 'Corrigez les critiques en premier pour faire bouger le score.',
  'sec.critical': 'Critiques',
  'sec.high': 'Élevés',
  'sec.medium': 'Moyens',
  'sec.low': 'Faibles',
  'sec.searchFindings': 'rechercher un finding…',
  'sec.noMatch': '✓ Aucun finding ne correspond à ces filtres.',
  'sec.viewInStack': 'voir dans le stack →',
  'sec.disclaimer': 'Scan de posture déterministe — comment les choses sont configurées, pas de la détection de menace runtime. Un rapport propre veut dire « aucune mauvaise config parmi celles qu\'on vérifie », pas « prouvé sûr ».',

  'sto.capacity': 'Capacité',
  'sto.volumes': '{n} volumes',
  'sto.orphaned': 'Orphelins',
  'sto.orphanedHint': 'released / non liés',
  'sto.wastedMo': '~{n}$/mois gaspillés',
  'sto.unmounted': 'PVC non montés',
  'sto.unmountedHint': 'liés, personne ne les utilise',
  'sto.classes': 'Storage classes',

  'common.loading': 'chargement',
}

const DICTS: Record<Locale, Record<string, string>> = { en: EN, fr: FR }

function detectInitial(): Locale {
  const saved = localStorage.getItem('kf-locale')
  if (saved === 'en' || saved === 'fr') return saved
  return navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

interface I18nCtx {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const Ctx = createContext<I18nCtx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial)
  const setLocale = (l: Locale) => {
    setLocaleState(l)
    localStorage.setItem('kf-locale', l)
    document.documentElement.lang = l
  }
  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = DICTS[locale][key] ?? EN[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>
}

export function useT() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useT must be used within I18nProvider')
  return c
}
