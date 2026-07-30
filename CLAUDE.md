# KubeForge

A **local-first Kubernetes analysis web app**. Single Go binary that serves an
embedded React/TS frontend and opens localhost in the browser. Module
`github.com/Mrg77/kubeforge`. Public, MIT, © Mrg77.

## What it is (and the positioning)

Not another resource browser. KubeForge **analyzes** a cluster across five angles
and unifies tools you'd otherwise juggle (OpenCost + Trivy + Popeye + Polaris):

1. **Health / debug** — why a pod/deployment is failing.
2. **FinOps** — waste, over-provisioning, estimated cost.
3. **SecOps** — loose policies (broad RBAC, lax securityContext, missing
   NetworkPolicies), outdated versions/CVEs, risky secrets/permissions.
4. **Storage** — PV/PVC/SC, orphaned/unmounted volumes.
5. **Trends** — periodic snapshots (SQLite/JSONL) → evolution over time.

**Pitch:** "The honest open-source alternative to Lens — it doesn't just display
your cluster, it analyzes it. Light, local, no account." (Lens betrayed its OSS
community: forced login → paywall → source deleted Jan 2024.) Every module is
**deterministic detection first**, AI as an opt-in explanation/prioritization layer.

## Architecture

- Single Go binary, frontend embedded via `go:embed` (built before compile).
- `cmd/` — cobra entry; `internal/` — the engine:
  - `cluster/` — client-go (typed + discovery/dynamic), universal resource
    discovery (61 kinds + CRDs). **`layers.go`** builds the flagship *Resource
    stack* (a namespace stacked bottom→top with real dependency edges read from specs).
    `provider.go` auto-detects cloud from node `providerID` (aws/gce/azure/kind).
  - `secops/ finops/ storage/ health/` — the deterministic analyzers.
  - `history/` — SQLite snapshots for trends. `ai/` — BYOK (Anthropic/OpenAI/Ollama).
  - `api/` — HTTP routes + an 8s TTL memory cache; `web/` — serves the embedded UI.
- `web/ui/` — React + Vite + TS + Tailwind v4, Recharts. Dark "infra console",
  forge-amber accent. Views in `src/views/` (topo lenses in `src/views/topo/`).

## Signature dataviz (the moat — keep these excellent)

1. **Resource stack** (`topo/Layered.tsx`) — the flagship view. Directional edges,
   hover detail panel (IP, image, monthly cost, age), click → YAML(secrets
   redacted)/events drawer, inline SecOps pills, CRD badges.
2. **FinOps treemap** + radial efficiency gauge + reserved-vs-used area band
   (the hatched gap = the waste; `isAnimationActive=false` so it renders headless).
3. **Topology heatmap** — scales to 500+ pods; force-directed graph is deterministic
   (no RNG).

## Working conventions (IMPORTANT)

- **Deterministic detects, AI explains.** Never leak raw cluster data to an LLM —
  AI is opt-in and only ever receives the deterministic findings. Everything works
  with no API key.
- **Local-first, fail-safe.** Phase 1 binds localhost only (nothing exposed). Phase 2
  (team) = same binary on a server + auth + TLS, by config, not rewrite.
- **Honest numbers.** A local cluster shows "estimate only, no real billing" — never
  fake cloud prices. `metrics-server` required for real usage figures.
- **SecOps/FinOps at scale**: group findings by `code` ("run as root · 33 objects"),
  hide system namespaces by default, posture score computed on non-system `ownCounts`
  (reflects the user's workloads, not Kubernetes' own).
- **i18n**: full EN/FR (`web/ui/src/i18n.tsx`, `useT()`); backend emits a stable
  `code` + EN, the front maps FR/EN. Keep every view + finding translated.
- **README**: `README.md` (EN) + `README.fr.md` (FR) must both stay current and
  explain everything, updated with each feature. A separate public guide lives in
  `../devops-guides/kubeforge-guide.html` — update/push it in its own repo.
- **Validate end-to-end on a real cluster** — a disposable `kind` cluster with a
  dedicated kubeconfig (NEVER `~/.kube/config`). Show results in a screenshot.
- **Ship in showable increments** — this is a large full-stack project; never aim
  for everything at once or it never lands.

## Release

- CI (`.github/workflows/ci.yml`): build front + `go vet` + build + `--version` smoke.
- Release via goreleaser on tag `v*`: 5 targets, `CGO_ENABLED=0` (pure-Go sqlite),
  `before` hook builds the frontend, Homebrew cask pushed to `Mrg77/homebrew-tap`.
  `brew install mrg77/tap/kubeforge` works. Bump → tag `vX.Y.Z` → push tag.
- `HOMEBREW_TAP_TOKEN` secret must live on the **kubeforge** repo (where the workflow runs).

## Identity

Public repo → **pseudonym only**: `Mrg77` + GitHub noreply email. Never a real name
or personal email anywhere in the repo. Check `git config user.email` before committing.
Respond to the user in **French**.
