<div align="center">

# 🔨 KubeForge

**A local-first web console to actually _understand_ — and optimize — your Kubernetes cluster.**

One binary. One command. It opens a console in your browser, reads your cluster, and answers the questions the usual tools leave hanging: _where am I wasting money, how is this thing wired, is it getting better or worse over time, and where are the security holes?_

[English](README.md) · [Français](README.fr.md)

![KubeForge — a tour of the console](docs/img/demo.gif)

</div>

---

## Why this exists

There are already good Kubernetes tools. `kubectl` is the source of truth but it's a firehose. `k9s` is a fantastic terminal UI — but it's a live table: it has no memory, it doesn't cost anything, it doesn't tell you your RBAC is wide open. Lens is beautiful — and then it went closed-source and gated behind a login, which is a rough thing to build a workflow on.

KubeForge is the honest, local-first take on that idea. It's a single Go binary with the whole web UI baked in. You run it, it talks to your cluster from your machine, and **nothing is exposed** — it binds to `127.0.0.1` by default. No account, no telemetry, no SaaS in the middle.

The bet is simple: don't build _yet another resource browser_. Build the three or four views that answer questions the other tools don't:

| Question | KubeForge answers with |
| --- | --- |
| **Where is my money going?** | A FinOps treemap — spend per namespace, colored by how much of it is waste. |
| **How is my cluster actually wired?** | A topology graph — services → the pods they select → the node each runs on. |
| **Is it getting better or worse?** | Trend charts with memory, including a reserved-vs-used CPU band where the shaded gap _is_ the waste. |
| **Where are the security holes?** | A deterministic SecOps scan — privileged pods, host access, open RBAC, mutable image tags. |
| **And everything else?** | A universal resource browser that lists **every** kind in the cluster — built-ins and your CRDs. |

---

## What's inside

- **Overview** — cluster health at a glance: pods, unhealthy-first, nodes, restarts. The one screen you check first.
- **Topology** — two lenses over the same graph. A *graph* view for the wiring (hover a service, its whole path lights up) and a *heatmap* view that stays readable at 500+ pods.
- **Resources** — a universal browser built on the discovery + dynamic client, so it lists anything the API server knows about, including custom resources. Self-managed clusters with hand-rolled CRDs are first-class.
- **Storage** — PVs, PVCs and StorageClasses in one place, with orphaned volumes and unmounted claims called out (that's storage you're paying for and not using).
- **FinOps** — a cost-and-waste engine. It reasons about the two things that actually drive Kubernetes waste — resources requested but not used, and workloads with no limits at all — and turns them into right-sizing advice and an estimated monthly cost. The treemap ranks where to look first.
- **SecOps** — a deterministic security-posture scan (no LLM, no guessing): privileged containers, `hostNetwork`/`hostPID`, dangerous capabilities, run-as-root, mutable image tags, namespaces with no NetworkPolicy, cluster-admin handed to the wrong subjects. Every finding comes with a plain-English _why_ and a fix.
- **Insights** — trends over time, recorded locally in SQLite, plus an **opt-in AI layer** (see below).

---

## The AI layer — opt-in, bring-your-own-key

There's an **Ask AI** button in the header on every view. It's completely optional and off by default.

When you turn it on, you provide your own key — **Anthropic**, or any **OpenAI-compatible** endpoint, including a **local Ollama** so nothing leaves your machine at all. KubeForge then does two things a plain dashboard can't:

1. **Summarize & prioritize** — turn a wall of findings into "here are the three things to fix first, and why."
2. **Analyze trends** — look at the recorded history and tell you the _direction_: is waste creeping up, did that security fix actually stick?

**What it sends:** only the _findings_ — counts, titles, trend numbers. Never raw cluster objects, never secrets. The key is stored locally (`0600`) and is never sent back to the browser. If you never configure it, every other feature works exactly the same.

---

## Install & run

You'll need Go 1.26+ and a kubeconfig that can reach a cluster.

```bash
# clone and build the single binary (the UI is embedded — no separate frontend to serve)
git clone https://github.com/Mrg77/kubeforge.git
cd kubeforge
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
| **FinOps** — spend by namespace, colored by waste | **SecOps** — findings, severity, and the fix |
| ![FinOps](docs/img/finops.png) | ![SecOps](docs/img/secops.png) |
| **Topology** — the wiring, service → pod → node | **Insights** — reserved vs. used CPU over time |
| ![Topology](docs/img/topology-graph.png) | ![Insights](docs/img/insights.png) |

---

## How it's built

- **Go + client-go** for the backend. A typed client for the common views, and the **discovery + dynamic client** for the universal resource browser — that's how it lists CRDs it's never heard of.
- **React + TypeScript + Vite + Tailwind** for the UI, **Recharts** and hand-written SVG for the visualizations.
- The whole frontend is compiled and **embedded into the binary** with `go:embed`, so shipping KubeForge is shipping one file.
- **SQLite** (pure-Go, no CGO) for the local history — small summaries, never full cluster dumps.
- Everything read-only. KubeForge looks at your cluster; it never changes it.

---

## Status & roadmap

KubeForge is young and moving fast. It already does the five pillars above end-to-end. On the list next: per-node inode and disk-pressure signals, predictive storage-saturation alerts, and packaging (Homebrew, a release binary) so you don't have to build it yourself.

Issues and ideas are welcome.

## License

MIT.
