<div align="center">

# 🔨 KubeForge

**A local-first web console to actually _understand_ — and optimize — your Kubernetes cluster.**

One binary. One command. It opens a console in your browser, reads your cluster, and answers the questions the usual tools leave hanging: _where am I wasting money, how is this thing wired, is it getting better or worse over time, and where are the security holes?_

[![CI](https://github.com/Mrg77/kubeforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrg77/kubeforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-forge.svg?color=d97a2b)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8.svg)](go.mod)

[English](README.md) · [Français](README.fr.md)

![KubeForge — the Resource stack of a namespace](docs/img/resource-stack.png)

<sub>The **Resource stack**: a namespace drawn from traffic-in (top) down to config, identity and storage (bottom) — every edge a real reference.</sub>

<br>

![KubeForge — a tour of the console](docs/img/demo.gif)

<sub>A quick tour: the pillar hub, the Resource stack, the workload graph, the FinOps and SecOps dashboards, and trends over time.</sub>

</div>

---

## Why this exists

There are already good Kubernetes tools. `kubectl` is the source of truth but it's a firehose. `k9s` is a fantastic terminal UI — but it's a live table: it has no memory, it doesn't cost anything, it doesn't tell you your RBAC is wide open. Lens is beautiful — and then it went closed-source and gated behind a login, which is a rough thing to build a workflow on.

KubeForge is the honest, local-first take on that idea. It's a single Go binary with the whole web UI baked in. You run it, it talks to your cluster from your machine, and **nothing is exposed** — it binds to `127.0.0.1` by default. No account, no telemetry, no SaaS in the middle.

The bet is simple: don't build _yet another resource browser_. Build the three or four views that answer questions the other tools don't:

| Question | KubeForge answers with |
| --- | --- |
| **How does everything in this namespace fit together?** | The **Resource stack** — every object drawn low→high (Ingress → Service → Pod → Config/RBAC/Storage), each edge a real reference read from a spec. Hover for IP, image and monthly cost; click for the live manifest and events. |
| **Where is my money going?** | A FinOps **dashboard** — efficiency gauge, editable pricing (AWS/GCP/Azure presets), cost grouped by workload, and a treemap of spend by namespace colored by waste. |
| **Is it getting better or worse?** | Trend charts with memory, including a reserved-vs-used CPU band where the shaded gap _is_ the waste. |
| **How secure is it?** | A deterministic SecOps scan with a **posture score** — privileged pods, host access, open RBAC, mutable image tags, each with a plain _why_ and fix. |
| **And everything else?** | A universal resource browser that lists **every** kind in the cluster — built-ins and your CRDs. |

---

## What's inside

- **Overview** — a hub: four pillar cards (cost, security, storage, topology) give each area's headline and link into it, over a health table with unhealthy pods surfaced first.
- **Topology** — five lenses over the same cluster graph:
  - **Resource stack** _(the headline)_ — a namespace as a layered graph, high-level (Ingress) down to low-level (Secrets, RBAC, storage). Nodes carry inline SecOps warnings and a `CRD` badge for operator resources; hover for facts (IP, image, monthly cost), click for the live manifest (secrets redacted) and recent events.
  - **Namespaces / Workload graph / By node / Heatmap** — the same graph as namespace cards, a force-directed workload graph, a per-node view, or a fleet heatmap that scales past 500 pods.
- **FinOps** — a real cost dashboard: a cluster-efficiency gauge (used vs reserved CPU), cost **grouped by workload** (expandable to pods) with filter/search/sort, a top-wasters chart, and the spend-by-namespace treemap. Pricing **auto-detects your cloud** from the nodes' `providerID` (AWS/GCP/Azure) and applies matching defaults — a local cluster (kind/minikube) is honestly flagged "estimate only, no real billing". You can still override the per-core / per-GB price.
- **SecOps** — a deterministic security-posture scan with a **0–100 posture score** computed from _your_ workloads (system namespaces excluded, so Kubernetes' own privileged pods don't sink your grade). It flags privileged containers, `hostNetwork`/`hostPID`, dangerous capabilities, run-as-root, mutable image tags, namespaces with no NetworkPolicy, and cluster-admin on the wrong subjects. Identical findings are **grouped** ("may run as root · 33 objects" instead of 33 rows), system noise is hidden by default, every finding has a plain _why_ + fix and a jump into the Resource stack, and the whole report exports to **CSV**.
- **Storage** — PVs, PVCs and StorageClasses in one place, with orphaned volumes and unmounted claims called out and **costed** (that's storage you're paying for and not using).
- **Resources** — a universal browser built on the discovery + dynamic client, so it lists anything the API server knows about, including custom resources.
- **Insights** — trends over time, recorded locally in SQLite, plus an **opt-in AI layer** (see below).

---

## The AI layer — opt-in, and free to use

There's an **Ask AI** button in the header on every view. It opens a **chat with your cluster** — ask anything and get an answer grounded in the live scans, not a guess:

- _"Why is `payments` failing?"_ → it reads the pod's **events** and tells you: `ImagePullBackOff`, the image tag doesn't exist, here's the `kubectl` to confirm.
- _"Where am I wasting the most?"_ → it reads **FinOps** and names the workload, the reserved-vs-used gap, and a ready-to-apply `resources:` snippet.
- _"Any weak points in my setup?"_ → it reads the posture and topology and points at the real risks.

Suggested questions get you started in one click, and it's a real multi-turn conversation (ask follow-ups). Under the hood, each question is answered from the deterministic scans (health/security/cost) plus the events of any pod you name — so the AI **explains and fixes**, it never invents findings.

**No need to pay.** Pick any provider — **Gemini** and **Groq** hand out a **free API key** (no card), and they're surfaced first. **Claude, ChatGPT, Mistral, DeepSeek, Grok, OpenRouter** and any **Custom OpenAI-compatible endpoint** (self-hosted LiteLLM/vLLM, …) are there too for those who already have a paid API key. A chat subscription (Claude Max, ChatGPT Plus) does **not** include API access — KubeForge says so instead of letting you hit a cryptic "no credit" error. Enter your key, click **load my models** to pull your real model list, **Test connection**, save.

**Speaks your language.** The analysis comes back in the UI's language (EN/FR).

**What it sends:** only the _findings_ — counts, titles, resource names, trend numbers. Never raw cluster objects, never secrets. The key is stored locally (`0600`) and is never sent back to the browser. If you never configure it, every other feature works exactly the same.

---

## Install & run

**With Homebrew** (once the first release is tagged):

```bash
brew install mrg77/tap/kubeforge
kubeforge serve
```

**Or build from source** — you'll need Go 1.26+ and a kubeconfig that can reach a cluster:

```bash
git clone https://github.com/Mrg77/kubeforge.git
cd kubeforge
# build the embedded frontend, then the single binary
( cd web/ui && npm ci && npm run build )
go build -o kubeforge .

# run it — it connects to your current context and opens the browser
./kubeforge serve
```

That's it. The console is at `http://127.0.0.1:7777`.

### Common flags

```bash
./kubeforge serve --context prod-eu        # pick a kubeconfig context
./kubeforge serve --kubeconfig ./kubeconfig # point at a specific file
./kubeforge serve --port 8080               # or --port 0 to auto-pick a free one
./kubeforge serve --no-open                 # don't launch the browser
./kubeforge serve --host 0.0.0.0            # expose it (see the note below first)
```

> **On exposing it.** The default `127.0.0.1` bind means the console is yours and nobody else's. You _can_ run KubeForge on a server and expose it with `--host 0.0.0.0` — but then it's reachable over the network, so put it behind auth and TLS. Local-first is the default for a reason.

### Metrics

FinOps usage numbers and the reserved-vs-used band need [metrics-server](https://github.com/kubernetes-sigs/metrics-server) in the cluster. Everything else works without it — KubeForge just hides the usage half and says so, rather than inventing numbers.

---

## Snapshots

| | |
| --- | --- |
| **FinOps** — efficiency gauge, editable pricing, cost by workload | **SecOps** — posture score, severity filters, fix per finding |
| ![FinOps](docs/img/finops.png) | ![SecOps](docs/img/secops.png) |
| **Overview** — the pillar hub | **Insights** — reserved vs. used CPU over time |
| ![Overview](docs/img/overview.png) | ![Insights](docs/img/insights.png) |

---

## Built for real clusters

A demo looks fine on three pods; a real cluster has hundreds. KubeForge is built to stay readable and fast at that size:

- **Grouped findings.** SecOps buckets identical findings — "may run as root · 33 objects" is one expandable card, not 33. System namespaces (kube-system, kindnet…) are hidden by default because they're privileged _by design_ and would otherwise bury your own issues.
- **Honest posture score.** The 0–100 grade is computed from your workloads only, so Kubernetes' own privileged system pods don't drag every cluster to an "F".
- **Capped layers.** The Resource stack shows the first N objects per layer with a "+N more" expander, and sorts problems (unhealthy, then risky) to the front — so a 100-pod namespace stays legible and never hides what needs attention. The topology heatmap scales past 500 pods.
- **Paginated tables.** Long lists (the Overview pod table) are searchable and paginated, so the UI renders instantly instead of a wall of rows.
- **Cached scans.** The whole-cluster scans (SecOps, FinOps, Storage) are memoized for a few seconds, so the burst of calls a single view fires collapses into one real scan.

## Bilingual (EN / FR)

The whole UI is available in **English and French** — a toggle in the sidebar, your browser's language detected on first run, your choice remembered. Security findings, cost labels, the resource stack — everything translates, not just the menus.

## How it's built

- **Go + client-go** for the backend. A typed client for the common views, and the **discovery + dynamic client** for the universal resource browser — that's how it lists CRDs it's never heard of.
- **React + TypeScript + Vite + Tailwind** for the UI, **Recharts** and hand-written SVG for the visualizations.
- The whole frontend is compiled and **embedded into the binary** with `go:embed`, so shipping KubeForge is shipping one file.
- **SQLite** (pure-Go, no CGO) for the local history — small summaries, never full cluster dumps.
- Everything read-only. KubeForge looks at your cluster; it never changes it.

---

## Status & roadmap

KubeForge is young and moving fast. All the pillars above work end-to-end, it ships as a Homebrew cask and a release binary, it's bilingual (EN/FR), and the Resource stack, FinOps and SecOps dashboards are validated against a real multi-node cluster with grouping, pagination, cloud-price auto-detection and scan caching for scale. On the list next: per-node inode and disk-pressure signals, predictive storage-saturation alerts, and richer CRD-aware edges in the stack.

Issues and ideas are welcome.

## License

MIT.
