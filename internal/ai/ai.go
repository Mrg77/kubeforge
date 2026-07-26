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
	"io"
	"net/http"
	"strings"
	"time"
)

// Provider is a chat-completions backend. Bring your own key for any of them.
type Provider string

const (
	ProviderAnthropic Provider = "anthropic" // Claude
	ProviderOpenAI    Provider = "openai"    // ChatGPT (and any OpenAI-compatible endpoint)
	ProviderGoogle    Provider = "google"    // Gemini
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
	case ProviderGoogle:
		return c.google(ctx, system, user)
	default:
		return c.openAI(ctx, system, user)
	}
}

// Ping makes a tiny real call to verify the key/model/endpoint work, so the UI
// can say "connected" or show the exact error before the user relies on it.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Complete(ctx, "You are a health check.", "Reply with the single word: ok")
	return err
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
	url := chatCompletionsURL(c.baseURL("https://api.openai.com"))
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

// google calls the Gemini generateContent API. Its shape differs from the other
// two: the system prompt goes in systemInstruction, the key is a query param,
// and the model name is in the URL path.
func (c *Client) google(ctx context.Context, system, user string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"systemInstruction": map[string]any{"parts": []map[string]string{{"text": system}}},
		"contents":          []map[string]any{{"role": "user", "parts": []map[string]string{{"text": user}}}},
	})
	base := c.baseURL("https://generativelanguage.googleapis.com")
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", base, c.cfg.Model, c.cfg.APIKey)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")

	var out struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := c.do(req, &out); err != nil {
		return "", err
	}
	if out.Error != nil {
		return "", fmt.Errorf("google: %s", out.Error.Message)
	}
	if len(out.Candidates) == 0 || len(out.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("google: empty response")
	}
	return out.Candidates[0].Content.Parts[0].Text, nil
}

func (c *Client) baseURL(def string) string {
	if c.cfg.BaseURL != "" {
		return c.cfg.BaseURL
	}
	return def
}

// chatCompletionsURL builds the OpenAI-compatible endpoint from a base, but is
// forgiving about how much of the path the caller already provided — so any
// OpenAI-compatible provider (Mistral, Groq, DeepSeek, xAI, OpenRouter, a local
// LiteLLM/vLLM…) works whether its base is a host, a host+/v1, or the full URL.
func chatCompletionsURL(base string) string {
	b := strings.TrimRight(base, "/")
	switch {
	case strings.HasSuffix(b, "/chat/completions"):
		return b // already the full endpoint
	case strings.HasSuffix(b, "/v1"):
		return b + "/chat/completions" // base includes the version segment
	default:
		return b + "/v1/chat/completions" // bare host
	}
}

func (c *Client) do(req *http.Request, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	// On an HTTP error, providers disagree on the error shape (object vs string,
	// nested vs flat). Surface a clean message from the raw body + status rather
	// than letting a strict decode fail with "cannot unmarshal…".
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s", errMessage(raw, resp.StatusCode))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("unexpected response (HTTP %d)", resp.StatusCode)
	}
	return nil
}

// errMessage extracts a human message from a provider's error body, tolerating
// {"error":{"message":…}}, {"error":"…"}, {"message":…}, or plain text.
func errMessage(body []byte, status int) string {
	var probe struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	_ = json.Unmarshal(body, &probe)
	if probe.Message != "" {
		return probe.Message
	}
	if len(probe.Error) > 0 {
		// try object {message}
		var obj struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(probe.Error, &obj) == nil && obj.Message != "" {
			return obj.Message
		}
		// try bare string
		var str string
		if json.Unmarshal(probe.Error, &str) == nil && str != "" {
			return str
		}
	}
	if s := strings.TrimSpace(string(body)); s != "" && len(s) < 300 {
		return s
	}
	return fmt.Sprintf("request failed (HTTP %d)", status)
}
