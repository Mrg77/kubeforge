// Package api exposes KubeForge's cluster data over a small HTTP/JSON API that
// the web UI consumes. It is deliberately thin: it validates the request,
// calls the cluster package, and shapes the JSON. All the real work lives in
// internal/cluster (and, later, internal/health and the FinOps module).
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Mrg77/kubeforge/internal/ai"
	"github.com/Mrg77/kubeforge/internal/cluster"
	"github.com/Mrg77/kubeforge/internal/finops"
	"github.com/Mrg77/kubeforge/internal/history"
	"github.com/Mrg77/kubeforge/internal/secops"
	"github.com/Mrg77/kubeforge/internal/storage"
)

// Server holds the dependencies the handlers need.
type Server struct {
	cluster *cluster.Client
	history *history.Store // optional; nil disables the trend endpoint
	cache   *ttlCache      // short memo for expensive whole-cluster scans
}

// scanTTL is how long a whole-cluster scan is reused. Short enough that the UI
// always feels live, long enough to collapse the burst of calls a single view
// (or the Overview hub) fires at once.
const scanTTL = 8 * time.Second

// New builds an API server over a connected cluster client. store may be nil.
func New(c *cluster.Client, store *history.Store) *Server {
	return &Server{cluster: c, history: store, cache: newTTLCache(scanTTL)}
}

// Routes registers the JSON endpoints on a mux and returns it. Kept separate
// from the web server so the API can be tested without the static frontend.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/cluster", s.handleCluster)
	mux.HandleFunc("GET /api/pods", s.handlePods)
	mux.HandleFunc("GET /api/nodes", s.handleNodes)
	mux.HandleFunc("GET /api/topology", s.handleTopology)
	mux.HandleFunc("GET /api/layers", s.handleLayers)
	mux.HandleFunc("GET /api/namespaces", s.handleNamespaces)
	mux.HandleFunc("GET /api/object/yaml", s.handleObjectYAML)
	mux.HandleFunc("GET /api/object/events", s.handleObjectEvents)
	// Generic resource browser: discover every kind, then list any of them.
	mux.HandleFunc("GET /api/resources", s.handleResourceKinds)
	mux.HandleFunc("GET /api/resources/{group}/{version}/{name}", s.handleListResource)
	// Security posture scan.
	mux.HandleFunc("GET /api/secops", s.handleSecOps)
	// FinOps: waste & cost estimate.
	mux.HandleFunc("GET /api/finops", s.handleFinOps)
	// Storage: PV/PVC/StorageClass + orphaned-volume waste.
	mux.HandleFunc("GET /api/storage", s.handleStorage)
	// History: snapshots over time, for trend charts and AI trend analysis.
	mux.HandleFunc("GET /api/history", s.handleHistory)
	// AI (opt-in, bring-your-own-key): config + analysis endpoints.
	mux.HandleFunc("GET /api/ai/config", s.handleAIConfig)
	mux.HandleFunc("POST /api/ai/config", s.handleAISaveConfig)
	mux.HandleFunc("POST /api/ai/test", s.handleAITest)
	mux.HandleFunc("POST /api/ai/models", s.handleAIModels)
	mux.HandleFunc("POST /api/ai/summary", s.handleAISummary)
	mux.HandleFunc("POST /api/ai/trends", s.handleAITrends)
	mux.HandleFunc("POST /api/ai/chat", s.handleAIChat)
	return mux
}

// handleAIConfig reports whether the AI layer is configured (never returns the
// key itself — only provider/model and a configured flag).
func (s *Server) handleAIConfig(w http.ResponseWriter, r *http.Request) {
	cfg := ai.LoadConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": cfg.Configured(),
		"provider":   cfg.Provider,
		"model":      cfg.Model,
		"baseUrl":    cfg.BaseURL,
	})
}

// handleAISaveConfig persists the user's AI settings (provider/model/key) locally.
func (s *Server) handleAISaveConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := ai.SaveConfig(ai.Provider(in.Provider), in.Model, in.BaseURL, in.APIKey); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

// handleAITest verifies a provider/model/key with one tiny real call, WITHOUT
// saving it — so the settings form can say "connected" or show the exact error
// (invalid key, unknown model…) before the user commits the config.
func (s *Server) handleAITest(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var in struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid body"})
		return
	}
	// If the key field is blank, fall back to the saved key (so "Test" works on
	// an already-configured provider without retyping the secret).
	key := in.APIKey
	if key == "" {
		key = ai.LoadConfig().APIKey
	}
	client := ai.New(ai.Config{Provider: ai.Provider(in.Provider), Model: in.Model, BaseURL: in.BaseURL, APIKey: key})
	if !client.Configured() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "provide a model and an API key"})
		return
	}
	if err := client.Ping(ctx); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAIModels lists the models the given key/provider can access, so the UI
// can populate the model dropdown with the real, current catalog. Not saved.
func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var in struct {
		Provider string `json:"provider"`
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}
	key := in.APIKey
	if key == "" {
		key = ai.LoadConfig().APIKey
	}
	if key == "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "enter an API key first"})
		return
	}
	// Model isn't needed to list models; pass a placeholder so Configured() passes.
	client := ai.New(ai.Config{Provider: ai.Provider(in.Provider), BaseURL: in.BaseURL, APIKey: key, Model: "list"})
	models, err := client.Models(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

// handleAIChat answers a free-form question about the cluster, grounded in the
// live deterministic scans (health/secops/finops) that KubeForge injects as
// context. If the question names a pod, its recent events are pulled in too, so
// "why is X crashing?" gets a real answer. Only aggregated findings + names are
// sent — never raw objects or secrets.
func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	var in struct {
		Messages []ai.Msg `json:"messages"`
		Lang     string   `json:"lang"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || len(in.Messages) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	client := ai.New(ai.LoadConfig())
	if !client.Configured() {
		writeJSON(w, http.StatusOK, map[string]string{"error": "AI is not configured"})
		return
	}

	// Assemble live context from the (cached) scans.
	cc := s.buildChatContext(ctx, in.Messages[len(in.Messages)-1].Text)
	system := ai.ChatSystemPrompt(cc, in.Lang)

	text, err := client.Chat(ctx, system, in.Messages)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// buildChatContext gathers the deterministic cluster data the chat answers from,
// plus events for any pod the question mentions by name.
func (s *Server) buildChatContext(ctx context.Context, question string) ai.ChatContext {
	cc := ai.ChatContext{}
	if v, err := s.cache.get("secops", time.Now(), func() (any, error) { return secops.Scan(ctx, s.cluster.Kube) }); err == nil {
		cc.Sec = v.(*secops.Report)
	}
	if v, err := s.cache.get("finops::", time.Now(), func() (any, error) {
		return finops.Scan(ctx, s.cluster.Kube, s.cluster.Metrics, finops.Prices{})
	}); err == nil {
		cc.Fin = v.(*finops.Report)
	}
	pods, _ := s.cluster.Pods(ctx, "")
	cc.Pods = len(pods)
	for _, p := range pods {
		if !p.Healthy {
			cc.Unhealthy++
			cc.Unhealthies = append(cc.Unhealthies, fmt.Sprintf("%s/%s — %s", p.Namespace, p.Name, p.Status))
		}
	}
	// If the question references a pod name, pull its events for real RCA.
	var evb strings.Builder
	seen := 0
	for _, p := range pods {
		if seen >= 3 {
			break
		}
		if strings.Contains(question, p.Name) || (p.Name != "" && strings.Contains(question, shortName(p.Name))) {
			if evs, err := s.cluster.ObjectEvents(ctx, p.Namespace, p.Name); err == nil && len(evs) > 0 {
				fmt.Fprintf(&evb, "%s/%s:\n", p.Namespace, p.Name)
				for i, e := range evs {
					if i >= 5 {
						break
					}
					fmt.Fprintf(&evb, "  [%s] %s: %s\n", e.Type, e.Reason, e.Message)
				}
				seen++
			}
		}
	}
	cc.PodEvents = evb.String()
	return cc
}

// shortName strips a pod's replica hash suffix ("web-7d4f-abc" -> "web").
func shortName(name string) string {
	parts := strings.Split(name, "-")
	if len(parts) > 2 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	return name
}

// handleAISummary runs the deterministic scans and asks the AI for a
// prioritized brief. Only aggregated findings are sent to the model.
func (s *Server) handleAISummary(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	client := ai.New(ai.LoadConfig())
	if !client.Configured() {
		writeJSON(w, http.StatusOK, map[string]string{"error": "AI is not configured"})
		return
	}
	sec, _ := secops.Scan(ctx, s.cluster.Kube)
	fin, _ := finops.Scan(ctx, s.cluster.Kube, s.cluster.Metrics, finops.Prices{})
	pods, _ := s.cluster.Pods(ctx, "")
	unhealthy := 0
	for _, p := range pods {
		if !p.Healthy {
			unhealthy++
		}
	}
	lang := r.URL.Query().Get("lang")
	text, err := client.Summarize(ctx, sec, fin, len(pods), unhealthy, lang)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// handleAITrends asks the AI to analyze the history snapshots.
func (s *Server) handleAITrends(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	client := ai.New(ai.LoadConfig())
	if !client.Configured() {
		writeJSON(w, http.StatusOK, map[string]string{"error": "AI is not configured"})
		return
	}
	if s.history == nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": "no history available"})
		return
	}
	snaps, _ := s.history.Since(ctx, s.cluster.Context, time.Now().Add(-30*24*time.Hour))
	lang := r.URL.Query().Get("lang")
	text, err := client.AnalyzeTrends(ctx, snaps, lang)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// handleStorage returns the PV/PVC/StorageClass picture + orphaned-volume waste.
func (s *Server) handleStorage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	rep, err := s.cache.get("storage", time.Now(), func() (any, error) {
		return storage.Scan(ctx, s.cluster.Kube)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleHistory returns the recorded snapshots for the current cluster, newest
// data feeding trend charts. ?since=7d limits the window (default 30d).
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	ctx, cancel := reqCtx(r)
	defer cancel()
	window := 30 * 24 * time.Hour
	if d := parseSince(r.URL.Query().Get("since")); d > 0 {
		window = d
	}
	snaps, err := s.history.Since(ctx, s.cluster.Context, time.Now().Add(-window))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snaps)
}

// parseSince accepts "7d", "24h", "30m"; returns 0 on empty/invalid.
func parseSince(s string) time.Duration {
	if s == "" {
		return 0
	}
	if len(s) > 1 && s[len(s)-1] == 'd' {
		var days int
		if _, err := fmt.Sscanf(s, "%dd", &days); err == nil && days > 0 {
			return time.Duration(days) * 24 * time.Hour
		}
		return 0
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return d
}

// handleFinOps computes the cost/waste report. Optional query params cpuHour and
// gbHour override the per-unit prices so the UI's price editor recomputes live.
func (s *Server) handleFinOps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	// Detect the cloud so cost defaults match where the cluster runs (and so we
	// can be honest that a local cluster has no real bill).
	provider := s.cluster.DetectProvider(ctx)

	// Prices: explicit query override wins; otherwise the detected provider's
	// defaults. A fully-unset query means "use the auto default".
	prices := finops.PricesFor(provider.ID)
	if v := parseFloat(r.URL.Query().Get("cpuHour")); v > 0 {
		prices.PerCPUHour = v
	}
	if v := parseFloat(r.URL.Query().Get("gbHour")); v > 0 {
		prices.PerGBHour = v
	}
	// Cache-key on the effective prices so overrides recompute, defaults reuse.
	key := fmt.Sprintf("finops:%g:%g", prices.PerCPUHour, prices.PerGBHour)
	v, err := s.cache.get(key, time.Now(), func() (any, error) {
		return finops.Scan(ctx, s.cluster.Kube, s.cluster.Metrics, prices)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	// Surface the detected provider alongside the report so the UI can label the
	// pricing (auto vs override) and flag local estimates.
	out := struct {
		*finops.Report
		Provider cluster.CloudProvider `json:"provider"`
	}{Report: v.(*finops.Report), Provider: provider}
	writeJSON(w, http.StatusOK, out)
}

func parseFloat(s string) float64 {
	var f float64
	if s == "" {
		return 0
	}
	fmt.Sscanf(s, "%g", &f)
	return f
}

// handleSecOps runs the deterministic security-posture scan (memoized briefly).
func (s *Server) handleSecOps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	rep, err := s.cache.get("secops", time.Now(), func() (any, error) {
		return secops.Scan(ctx, s.cluster.Kube)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleResourceKinds returns the catalog of every listable resource kind the
// cluster exposes (built-ins + CRDs) — the backbone of "browse any resource".
func (s *Server) handleResourceKinds(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	kinds, err := s.cluster.ResourceKinds(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, kinds)
}

// handleListResource lists objects of an arbitrary kind, addressed by its
// group/version/plural-name. Core resources use "core" for the group segment.
func (s *Server) handleListResource(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	group := r.PathValue("group")
	if group == "core" {
		group = ""
	}
	rk := cluster.ResourceKind{
		Group:   group,
		Version: r.PathValue("version"),
		Name:    r.PathValue("name"),
	}
	// Discover whether it's namespaced (needed to scope the list correctly).
	rk.Namespaced = s.cluster.IsNamespaced(ctx, rk)
	objs, err := s.cluster.ListResource(ctx, rk, r.URL.Query().Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, objs)
}

// clusterInfo is the "what am I connected to?" payload the UI shows in its
// header, so the user always knows which cluster they're looking at.
type clusterInfo struct {
	Context      string `json:"context"`
	Server       string `json:"server"`
	Version      string `json:"version"`
	Reachable    bool   `json:"reachable"`
	MetricsAvail bool   `json:"metricsAvailable"`
	Error        string `json:"error,omitempty"`
}

func (s *Server) handleCluster(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()

	info := clusterInfo{Context: s.cluster.Context, Server: s.cluster.Server}
	version, err := s.cluster.Ping(ctx)
	if err != nil {
		info.Error = err.Error()
		writeJSON(w, http.StatusOK, info) // reachable=false, but not a 500 — the UI shows the error
		return
	}
	info.Reachable = true
	info.Version = version
	info.MetricsAvail = s.cluster.HasMetrics(ctx)
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handlePods(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	ns := r.URL.Query().Get("namespace") // "" = all namespaces
	pods, err := s.cluster.Pods(ctx, ns)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pods)
}

func (s *Server) handleNodes(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	nodes, err := s.cluster.Nodes(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nodes)
}

func (s *Server) handleTopology(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	topo, err := s.cluster.BuildTopology(ctx, r.URL.Query().Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, topo)
}

// handleNamespaces returns the namespace names, for the layered-view selector.
func (s *Server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	names, err := s.cluster.Namespaces(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, names)
}

// handleObjectYAML returns one object's manifest (Secret data redacted), for the
// node "view manifest" action. Query: kind, namespace, name.
func (s *Server) handleObjectYAML(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	q := r.URL.Query()
	yamlStr, err := s.cluster.ObjectYAML(ctx, q.Get("kind"), q.Get("namespace"), q.Get("name"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"yaml": yamlStr})
}

// handleObjectEvents returns recent events for an object. Query: namespace, name.
func (s *Server) handleObjectEvents(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	q := r.URL.Query()
	evs, err := s.cluster.ObjectEvents(ctx, q.Get("namespace"), q.Get("name"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, evs)
}

// handleLayers returns the stacked resource graph for one namespace (Ingress
// down to Secrets/RBAC/storage, with the references between them).
func (s *Server) handleLayers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	ns := r.URL.Query().Get("namespace")
	g, err := s.cluster.LayeredNamespace(ctx, ns)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// reqCtx derives a request context with a sane timeout so a slow cluster can't
// pile up hanging handlers.
func reqCtx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 20*time.Second)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
}
