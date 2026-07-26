package web

import (
	"io/fs"
	"net"
	"net/http"
	"strings"
)

// listen opens a TCP listener, letting the OS pick a port when addr ends in :0.
func listen(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}

// spaHandler serves a single-page app from an fs.FS: real files are served as
// static assets, and any unknown path falls back to index.html so client-side
// routing (React Router) works on refresh/deep-link.
func spaHandler(uiFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(uiFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// If the requested file exists, serve it directly.
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := uiFS.Open(p); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		// Otherwise, this is a client-side route: serve index.html.
		r2 := new(http.Request)
		*r2 = *r
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}
