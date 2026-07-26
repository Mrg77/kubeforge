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
	"time"

	"github.com/Mrg77/kubeforge/internal/ai"
	"github.com/Mrg77/kubeforge/internal/cluster"
	"github.com/Mrg77/kubeforge/internal/finops"
	"github.com/Mrg77/kubeforge/internal/history"
	"github.com/Mrg77/kubeforge/internal/secops"
)

// Server holds the dependencies the handlers need.
type Server struct {
	cluster *cluster.Client
	history *history.Store // optional; nil disables the trend endpoint
}

// New builds an API server over a connected cluster client. store may be nil.
func New(c *cluster.Client, store *history.Store) *Server {
	return &Server{cluster: c, history: store}
}

// Routes registers the JSON endpoints on a mux and returns it. Kept separate
// from the web server so the API can be tested without the static frontend.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/cluster", s.handleCluster)
	mux.HandleFunc("GET /api/pods", s.handlePods)
	mux.HandleFunc("GET /api/nodes", s.handleNodes)
	// Generic resource browser: discover every kind, then list any of them.
	mux.HandleFunc("GET /api/resources", s.handleResourceKinds)
	mux.HandleFunc("GET /api/resources/{group}/{version}/{name}", s.handleListResource)
	// Security posture scan.
	mux.HandleFunc("GET /api/secops", s.handleSecOps)
	// FinOps: waste & cost estimate.
	mux.HandleFunc("GET /api/finops", s.handleFinOps)
	// History: snapshots over time, for trend charts and AI trend analysis.
	mux.HandleFunc("GET /api/history", s.handleHistory)
	// AI (opt-in, bring-your-own-key): config + analysis endpoints.
	mux.HandleFunc("GET /api/ai/config", s.handleAIConfig)
	mux.HandleFunc("POST /api/ai/config", s.handleAISaveConfig)
	mux.HandleFunc("POST /api/ai/summary", s.handleAISummary)
	mux.HandleFunc("POST /api/ai/trends", s.handleAITrends)
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
	text, err := client.Summarize(ctx, sec, fin, len(pods), unhealthy)
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
	text, err := client.AnalyzeTrends(ctx, snaps)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
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

// handleFinOps computes the cost/waste report.
func (s *Server) handleFinOps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	rep, err := finops.Scan(ctx, s.cluster.Kube, s.cluster.Metrics, finops.Prices{})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleSecOps runs the deterministic security-posture scan.
func (s *Server) handleSecOps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r)
	defer cancel()
	rep, err := secops.Scan(ctx, s.cluster.Kube)
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
