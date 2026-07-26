// Package ai is KubeForge's OPTIONAL, opt-in AI layer. It never detects
// anything — the deterministic engines (health/secops/finops) do that. The AI's
// job is to EXPLAIN and PRIORITIZE: turn a pile of findings into "here's the
// state of your cluster, and the 3-5 things to fix first", and to read the
// history and tell you whether things are getting better or worse.
//
// Privacy, by design:
//   - Bring-your-own-key: the user supplies their own API key. Nothing works
//     without it, and KubeForge never ships a key.
//   - It sends the FINDINGS (counts, titles, severities, trends) — not raw
//     cluster objects, secrets, or manifests. The model sees "3 privileged
//     pods", not their env vars.
//   - Off by default. If no key is configured, every AI endpoint reports
//     "not configured" and the rest of the app is unaffected.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Provider is a chat-completions backend. Anthropic and OpenAI-compatible
// (which also covers a local Ollama server) are supported.
type Provider string

const (
	ProviderAnthropic Provider = "anthropic"
	ProviderOpenAI    Provider = "openai" // also any OpenAI-compatible endpoint (Ollama, etc.)
)

// Config is the user-supplied AI configuration. Empty APIKey means AI is off.
type Config struct {
	Provider Provider `json:"provider"`
	APIKey   string   `json:"-"` // never serialized back to the client
	Model    string   `json:"model"`
	BaseURL  string   `json:"baseUrl,omitempty"` // override, e.g. a local Ollama URL
}

// Configured reports whether the AI layer can run.
func (c Config) Configured() bool { return c.APIKey != "" && c.Model != "" }

// Client calls the configured provider.
type Client struct {
	cfg  Config
	http *http.Client
}

// New builds an AI client. It makes no network call.
func New(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 60 * time.Second}}
}

// Configured exposes whether this client can run.
func (c *Client) Configured() bool { return c.cfg.Configured() }

// Complete sends a system + user prompt and returns the model's text. It is the
// single choke point every AI feature goes through, so provider quirks live in
// one place.
func (c *Client) Complete(ctx context.Context, system, user string) (string, error) {
	if !c.cfg.Configured() {
		return "", fmt.Errorf("AI is not configured (set a provider, model and API key)")
	}
	switch c.cfg.Provider {
	case ProviderAnthropic:
		return c.anthropic(ctx, system, user)
	default:
		return c.openAI(ctx, system, user)
	}
}

func (c *Client) anthropic(ctx context.Context, system, user string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":      c.cfg.Model,
		"max_tokens": 1024,
		"system":     system,
		"messages":   []map[string]string{{"role": "user", "content": user}},
	})
	url := c.baseURL("https://api.anthropic.com") + "/v1/messages"
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", c.cfg.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	var out struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := c.do(req, &out); err != nil {
		return "", err
	}
	if out.Error != nil {
		return "", fmt.Errorf("anthropic: %s", out.Error.Message)
	}
	if len(out.Content) == 0 {
		return "", fmt.Errorf("anthropic: empty response")
	}
	return out.Content[0].Text, nil
}

func (c *Client) openAI(ctx context.Context, system, user string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": c.cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	})
	url := c.baseURL("https://api.openai.com") + "/v1/chat/completions"
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+c.cfg.APIKey)

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := c.do(req, &out); err != nil {
		return "", err
	}
	if out.Error != nil {
		return "", fmt.Errorf("openai: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("openai: empty response")
	}
	return out.Choices[0].Message.Content, nil
}

func (c *Client) baseURL(def string) string {
	if c.cfg.BaseURL != "" {
		return c.cfg.BaseURL
	}
	return def
}

func (c *Client) do(req *http.Request, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}
