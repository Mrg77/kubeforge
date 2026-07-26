package ai

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// LoadConfig resolves the AI configuration from (in order) the saved config
// file and environment overrides. The API key comes from the environment or the
// saved file, never from a request body echoed back — so a key is never leaked
// through the API.
func LoadConfig() Config {
	cfg := Config{Provider: ProviderAnthropic, Model: "claude-haiku-4-5-20251001"}

	// Saved file (provider/model/baseUrl + optionally key).
	if raw, err := os.ReadFile(configPath()); err == nil {
		var saved struct {
			Provider Provider `json:"provider"`
			Model    string   `json:"model"`
			BaseURL  string   `json:"baseUrl"`
			APIKey   string   `json:"apiKey"`
		}
		if json.Unmarshal(raw, &saved) == nil {
			if saved.Provider != "" {
				cfg.Provider = saved.Provider
			}
			if saved.Model != "" {
				cfg.Model = saved.Model
			}
			cfg.BaseURL = saved.BaseURL
			cfg.APIKey = saved.APIKey
		}
	}

	// Environment overrides win (handy for a server deployment / CI).
	if k := os.Getenv("KUBEFORGE_AI_KEY"); k != "" {
		cfg.APIKey = k
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" && cfg.APIKey == "" {
		cfg.APIKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if os.Getenv("OPENAI_API_KEY") != "" && cfg.APIKey == "" {
		cfg.Provider = ProviderOpenAI
		cfg.APIKey = os.Getenv("OPENAI_API_KEY")
	}
	return cfg
}

// SaveConfig persists the AI settings (including the key) locally, mode 0600.
func SaveConfig(provider Provider, model, baseURL, apiKey string) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(map[string]string{
		"provider": string(provider), "model": model, "baseUrl": baseURL, "apiKey": apiKey,
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

func configPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(os.TempDir(), "kubeforge", "ai.json")
		}
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "kubeforge", "ai.json")
}
