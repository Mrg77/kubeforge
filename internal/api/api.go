// Package api exposes KubeForge's cluster data over a small HTTP/JSON API that
// the web UI consumes. It is deliberately thin: it validates the request,
// calls the cluster package, and shapes the JSON. All the real work lives in
// internal/cluster (and, later, internal/health and the FinOps module).
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Mrg77/kubeforge/internal/cluster"
)

// Server holds the dependencies the handlers need.
type Server struct {
	cluster *cluster.Client
}

// New builds an API server over a connected cluster client.
func New(c *cluster.Client) *Server {
	return &Server{cluster: c}
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
	return mux
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
