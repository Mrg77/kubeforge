// Package webui embeds the compiled frontend (web/dist) into the Go binary, so
// KubeForge ships as a single self-contained executable — no separate frontend
// to deploy. The dist/ directory is produced by the Vite build (npm run build).
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Dist returns the built frontend rooted at dist/, ready to serve. If the
// frontend hasn't been built, it still returns a valid (placeholder) FS.
func Dist() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return distFS
	}
	return sub
}
