// Package history stores periodic snapshots of the cluster's health, security
// and cost posture, so KubeForge can answer "is my cluster getting better or
// worse over time?" — the foundation the trend analysis (and the AI's
// time-based insights) build on.
//
// It uses a local SQLite file (pure-Go driver, no CGO) under the user's state
// dir. Snapshots are small summaries (a handful of numbers per scan), not full
// cluster dumps, so the database stays tiny and holds no secret material.
package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// Snapshot is one point-in-time summary of the cluster, keyed by context so a
// single KubeForge install can track several clusters independently.
type Snapshot struct {
	ID      int64     `json:"id"`
	Context string    `json:"context"`
	Time    time.Time `json:"time"`

	// Health
	Pods      int `json:"pods"`
	Unhealthy int `json:"unhealthy"`
	Restarts  int `json:"restarts"`

	// Security posture (finding counts by severity)
	SecCritical int `json:"secCritical"`
	SecHigh     int `json:"secHigh"`
	SecMedium   int `json:"secMedium"`

	// FinOps
	MonthlyReserved float64 `json:"monthlyReserved"`
	MonthlyWasted   float64 `json:"monthlyWasted"`
}

// Store is the history database.
type Store struct {
	db *sql.DB
}

// Path returns the SQLite file location under XDG_STATE_HOME.
func Path() string {
	dir := os.Getenv("XDG_STATE_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(os.TempDir(), "kubeforge", "history.db")
		}
		dir = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(dir, "kubeforge", "history.db")
}

// Open opens (creating if needed) the history store and ensures the schema.
func Open() (*Store, error) {
	p := Path()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", p)
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context TEXT NOT NULL,
  ts INTEGER NOT NULL,
  pods INTEGER, unhealthy INTEGER, restarts INTEGER,
  sec_critical INTEGER, sec_high INTEGER, sec_medium INTEGER,
  monthly_reserved REAL, monthly_wasted REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ctx_ts ON snapshots(context, ts);`)
	return err
}

// Record persists a snapshot.
func (s *Store) Record(ctx context.Context, snap Snapshot) error {
	if snap.Time.IsZero() {
		return fmt.Errorf("snapshot has no time")
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO snapshots (context, ts, pods, unhealthy, restarts, sec_critical, sec_high, sec_medium, monthly_reserved, monthly_wasted)
VALUES (?,?,?,?,?,?,?,?,?,?)`,
		snap.Context, snap.Time.Unix(), snap.Pods, snap.Unhealthy, snap.Restarts,
		snap.SecCritical, snap.SecHigh, snap.SecMedium, snap.MonthlyReserved, snap.MonthlyWasted)
	return err
}

// Since returns snapshots for a context newer than t, oldest first — the raw
// material for trend charts and AI trend analysis.
func (s *Store) Since(ctx context.Context, clusterCtx string, t time.Time) ([]Snapshot, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, ts, pods, unhealthy, restarts, sec_critical, sec_high, sec_medium, monthly_reserved, monthly_wasted
FROM snapshots WHERE context = ? AND ts >= ? ORDER BY ts ASC`, clusterCtx, t.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Snapshot
	for rows.Next() {
		var s Snapshot
		var ts int64
		if err := rows.Scan(&s.ID, &ts, &s.Pods, &s.Unhealthy, &s.Restarts,
			&s.SecCritical, &s.SecHigh, &s.SecMedium, &s.MonthlyReserved, &s.MonthlyWasted); err != nil {
			return nil, err
		}
		s.Time = time.Unix(ts, 0)
		s.Context = clusterCtx
		out = append(out, s)
	}
	return out, rows.Err()
}

// Latest returns the most recent snapshot for a context, or nil if none.
func (s *Store) Latest(ctx context.Context, clusterCtx string) (*Snapshot, error) {
	all, err := s.Since(ctx, clusterCtx, time.Unix(0, 0))
	if err != nil || len(all) == 0 {
		return nil, err
	}
	return &all[len(all)-1], nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// MarshalJSON keeps the time as RFC3339 for the API.
func (snap Snapshot) MarshalJSONTime() string { return snap.Time.Format(time.RFC3339) }

var _ = json.Marshal // reserved for future richer payloads
