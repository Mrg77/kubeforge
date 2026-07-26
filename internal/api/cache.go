package api

import (
	"sync"
	"time"
)

// ttlCache is a tiny concurrency-safe memo for expensive whole-cluster scans
// (secops, finops, storage…). On a large cluster these list thousands of objects
// each call; the UI often refetches several within a second (tab switches, the
// Overview hub pulling every pillar at once). A short TTL collapses those into
// one real scan without ever serving stale-feeling data.
//
// It's keyed by a string (endpoint + params) and stores the already-computed
// value. Entries are recomputed on expiry via the caller-supplied builder, under
// a per-key lock so a cache-miss stampede still runs the scan only once.
type ttlCache struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]*cacheEntry
}

type cacheEntry struct {
	mu       sync.Mutex // serializes rebuilds of THIS key
	value    any
	expires  time.Time
	hasValue bool
}

func newTTLCache(ttl time.Duration) *ttlCache {
	return &ttlCache{ttl: ttl, entries: map[string]*cacheEntry{}}
}

// get returns the cached value for key, or builds it via build() and caches it.
// build receives no context on purpose — callers close over the request context;
// a cached value outliving its request is fine, it's just data. Errors are never
// cached, so a transient failure doesn't stick.
func (c *ttlCache) get(key string, now time.Time, build func() (any, error)) (any, error) {
	c.mu.Lock()
	e := c.entries[key]
	if e == nil {
		e = &cacheEntry{}
		c.entries[key] = e
	}
	c.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.hasValue && now.Before(e.expires) {
		return e.value, nil
	}
	v, err := build()
	if err != nil {
		return nil, err
	}
	e.value = v
	e.expires = now.Add(c.ttl)
	e.hasValue = true
	return v, nil
}
