// Package web is KubeForge's local-first HTTP server: one binary that serves
// the compiled frontend AND the JSON API, on localhost, and opens the browser.
//
// LOCAL-FIRST, SAFE BY DEFAULT: it binds to 127.0.0.1 by default, so nothing is
// exposed to the network — the app is yours alone until you explicitly choose
// otherwise. Exposing it to a team (bind 0.0.0.0 + auth + TLS) is a later,
// deliberate step, not the default. That mirrors the fail-safe posture of the
// other tools in this family.
package web

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

// Config controls how the server binds and behaves.
type Config struct {
	// Host to bind. Defaults to 127.0.0.1 (localhost only) — the safe default.
	Host string
	// Port to listen on. 0 lets the OS pick a free port.
	Port int
	// Open, when true, opens the default browser at the server URL on start.
	Open bool
	// UI is the embedded, already-built frontend (dist/) to serve. When nil,
	// only the API is served (useful in dev with a separate Vite server).
	UI fs.FS
}

// Server ties the API mux and the static UI together.
type Server struct {
	cfg Config
	api http.Handler
}

// New builds the web server. api is the mux from internal/api.
func New(cfg Config, api http.Handler) *Server {
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	return &Server{cfg: cfg, api: api}
}

// handler composes the routes: /api/* goes to the JSON API, everything else is
// the single-page app (with SPA fallback to index.html for client-side routes).
func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", s.api)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	if s.cfg.UI != nil {
		mux.Handle("/", spaHandler(s.cfg.UI))
	}
	return mux
}

// Serve starts the server and blocks until ctx is cancelled. It prints the URL
// and (optionally) opens the browser once it's actually listening.
func (s *Server) Serve(ctx context.Context) error {
	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
	ln, err := listen(addr)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://%s", ln.Addr().String())

	srv := &http.Server{
		Handler:           s.handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	fmt.Printf("KubeForge is running at %s\n", url)
	if s.cfg.Host == "127.0.0.1" || s.cfg.Host == "localhost" {
		fmt.Println("  (local only — nothing is exposed to the network)")
	}
	if s.cfg.Open {
		openBrowser(url)
	}

	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// openBrowser best-effort opens the default browser. A failure is silent: the
// URL is already printed, so the user can click it themselves.
func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler"}
	default:
		cmd = "xdg-open"
	}
	_ = exec.Command(cmd, append(args, url)...).Start()
}
