package api

import "context"

// ProviderModel 是一个自定义提供商下的模型条目，也是 models.discover 与 models.putProvider 的单位。
// ContextWindow 是上下文窗口，MaxTokens 是单次回复的最大输出 token 数；服务会用它们换算压缩阈值，
// 所以两者都必须为正、且 MaxTokens 不能超过 ContextWindow。
type ProviderModel struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name,omitempty"`
	ContextWindow        int     `json:"contextWindow"`
	MaxTokens            int     `json:"maxTokens"`
	Reasoning            bool    `json:"reasoning"`
	Vision               bool    `json:"vision,omitempty"`
	InputCostPerMillion  float64 `json:"inputCostPerMillion,omitempty"`
	OutputCostPerMillion float64 `json:"outputCostPerMillion,omitempty"`
}

// DiscoveredModel 是 models.discover 返回的一项。Inferred 表示端点没有报告上下文长度或输出上限，
// 服务填了保守默认值（32k 窗口 / 4k 输出），界面必须提示用户核对。
type DiscoveredModel struct {
	ProviderModel
	Inferred bool `json:"inferred,omitempty"`
}

// ModelProvider 是 models.view 中的一个提供商。密钥只进不出：这里只有 HasStoredKey，没有密钥本身。
type ModelProvider struct {
	Kind         string          `json:"kind"` // "builtin" 或 "custom"
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	BaseURL      string          `json:"baseUrl,omitempty"`
	RequiresKey  bool            `json:"requiresKey,omitempty"`
	KeyRequired  bool            `json:"keyRequired"`
	Enabled      bool            `json:"enabled"`
	HasStoredKey bool            `json:"hasStoredKey"`
	AuthSource   *string         `json:"authSource"`
	Models       []ProviderModel `json:"models,omitempty"`
}

// ProviderPreset 是 models.view 附带的自定义端点预设（ollama、magpie、atlascloud）。
type ProviderPreset struct {
	PresetID    string `json:"presetId"`
	Name        string `json:"name"`
	BaseURL     string `json:"baseUrl"`
	RequiresKey bool   `json:"requiresKey"`
}

// ModelsView 是 models.view / models.putProvider 等设置方法的结果。DefaultModel 与 DefaultThinking
// 都在未设置时为 nil。
type ModelsView struct {
	Providers         []ModelProvider  `json:"providers"`
	BuiltinProviders  []string         `json:"builtinProviders"`
	Presets           []ProviderPreset `json:"presets"`
	DefaultModel      *ModelRef        `json:"defaultModel"`
	DefaultThinking   *string          `json:"defaultThinking"`
	CredentialBackend string           `json:"credentialBackend"`
}

// ProviderSettings 是 models.putProvider 的参数。Builtin 与 Custom 用同一结构承载，PutProvider 只会
// 发送该 kind 需要的字段（见方法实现）。
type ProviderSettings struct {
	Kind        string          `json:"kind"`
	ID          string          `json:"id"`
	Name        string          `json:"name,omitempty"`
	BaseURL     string          `json:"baseUrl,omitempty"`
	RequiresKey bool            `json:"requiresKey"`
	Enabled     bool            `json:"enabled"`
	Models      []ProviderModel `json:"models,omitempty"`
}

// ModelTestResult 是 models.test 的结果；失败是业务结果（ok=false 加 error），不是 RPC 错误。
type ModelTestResult struct {
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

// Usage 是一组 token 用量；字段与服务端 pi-ai 的 Usage 一致。
type Usage struct {
	Input       int       `json:"input"`
	Output      int       `json:"output"`
	CacheRead   int       `json:"cacheRead"`
	CacheWrite  int       `json:"cacheWrite"`
	Reasoning   *int      `json:"reasoning,omitempty"`
	TotalTokens int       `json:"totalTokens"`
	Cost        UsageCost `json:"cost"`
}

// UsageCost 是目录估算或提供商上报的费用（美元）。
type UsageCost struct {
	Input             float64 `json:"input"`
	Output            float64 `json:"output"`
	CacheRead         float64 `json:"cacheRead"`
	CacheWrite        float64 `json:"cacheWrite"`
	Total             float64 `json:"total"`
	TotalFromProvider bool    `json:"totalFromProvider,omitempty"`
}

// UsageSummary 是 usage.summary 的结果：整库汇总，按模型与工具分桶。
type UsageSummary struct {
	Models map[string]Usage `json:"models"`
	Tools  map[string]Usage `json:"tools"`
}

// ModelsView 读取模型设置（提供商、默认模型、各提供商的鉴权来源）、内置提供商 id 与端点预设。
func (c *Client) ModelsView(ctx context.Context) (*ModelsView, error) {
	var out ModelsView
	if err := c.callInto(ctx, "models.view", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DiscoverModels 从 OpenAI 兼容端点的 GET <baseUrl>/models 读取模型列表。apiKey 只用于这一次请求。
func (c *Client) DiscoverModels(ctx context.Context, baseURL, apiKey string) ([]DiscoveredModel, error) {
	params := struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey,omitempty"`
	}{baseURL, apiKey}
	var out struct {
		Models []DiscoveredModel `json:"models"`
	}
	err := c.callInto(ctx, "models.discover", params, &out)
	return out.Models, err
}

// PutProvider 保存（或新增）一个提供商并返回更新后的设置视图。
func (c *Client) PutProvider(ctx context.Context, p ProviderSettings) (*ModelsView, error) {
	params := map[string]any{"kind": p.Kind, "id": p.ID, "enabled": p.Enabled}
	if p.Kind == "custom" {
		params["name"] = p.Name
		params["baseUrl"] = p.BaseURL
		params["requiresKey"] = p.RequiresKey
		params["models"] = p.Models
	}
	var out ModelsView
	if err := c.callInto(ctx, "models.putProvider", params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteProvider 删除一个提供商及其密钥；指向它的默认模型会被清空。
func (c *Client) DeleteProvider(ctx context.Context, id string) (*ModelsView, error) {
	var out ModelsView
	if err := c.callInto(ctx, "models.deleteProvider", struct {
		ID string `json:"id"`
	}{id}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetProviderKey 写入一个提供商的 API key。响应里没有密钥，也永远拿不回来。
func (c *Client) SetProviderKey(ctx context.Context, providerID, key string) (*ModelsView, error) {
	var out ModelsView
	if err := c.callInto(ctx, "models.setKey", struct {
		ProviderID string `json:"providerId"`
		APIKey     string `json:"apiKey"`
	}{providerID, key}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClearProviderKey 删除一个提供商保存的 API key。
func (c *Client) ClearProviderKey(ctx context.Context, providerID string) (*ModelsView, error) {
	var out ModelsView
	if err := c.callInto(ctx, "models.clearKey", struct {
		ProviderID string `json:"providerId"`
	}{providerID}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetDefaultModel 设置默认模型与思考强度；model 为 nil 表示让服务自己选（第一个可用模型），
// thinking 为 nil 表示不指定。
func (c *Client) SetDefaultModel(ctx context.Context, model *ModelRef, thinking *string) (*ModelsView, error) {
	var out ModelsView
	params := struct {
		Model         *ModelRef `json:"model"`
		ThinkingLevel *string   `json:"thinkingLevel"`
	}{model, thinking}
	if err := c.callInto(ctx, "models.setDefault", params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TestModel 通过真实提供商发一次很小的请求。draft 用于测试尚未保存的设置（“先测后存”）：
// provider 与 apiKey 只用于这一次请求，不会写盘。
func (c *Client) TestModel(ctx context.Context, ref ModelRef, draft *ProviderSettings, apiKey string) (ModelTestResult, error) {
	params := struct {
		Model    ModelRef          `json:"model"`
		Provider *ProviderSettings `json:"provider,omitempty"`
		APIKey   string            `json:"apiKey,omitempty"`
	}{Model: ref, APIKey: apiKey}
	if draft != nil {
		p := *draft
		// 与 PutProvider 的线上形状一致：只发这个 kind 认的字段。
		if p.Kind == "builtin" {
			p = ProviderSettings{Kind: p.Kind, ID: p.ID, Enabled: p.Enabled}
		}
		params.Provider = &p
	}
	var out ModelTestResult
	err := c.callInto(ctx, "models.test", params, &out)
	return out, err
}

// UsageSummary 返回整库的 token 用量汇总，按模型与工具分桶。
func (c *Client) UsageSummary(ctx context.Context) (*UsageSummary, error) {
	var out UsageSummary
	if err := c.callInto(ctx, "usage.summary", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
