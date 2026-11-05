package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"datawhisper/desktop/internal/service"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// modelCall 是假服务收到的一次设置请求，参数保留 JSON 解码后的形状，便于检查实际发出去的字段。
type modelCall struct {
	Method string
	Params map[string]any
}

// modelFake 是设置页用到的 stateful 假服务：它保存模型设置、可用模型与用量，像真服务一样在
// putProvider / setKey / setDefault 之后返回新的设置视图。
type modelFake struct {
	t *testing.T

	mu      sync.Mutex
	closers []func()
	view    service.ModelsView
	avail   []service.AvailableModel
	usage   service.UsageSummary
	calls   []modelCall

	discover    []service.DiscoveredModel
	discoverErr map[string]any
	test        service.ModelTestResult
	testErr     map[string]any
	putErr      map[string]any
	defaultErr  map[string]any
}

func newModelFake(t *testing.T) *modelFake {
	f := &modelFake{
		t:     t,
		view:  service.ModelsView{CredentialBackend: "file"},
		usage: service.UsageSummary{Models: map[string]service.Usage{}, Tools: map[string]service.Usage{}},
		test:  service.ModelTestResult{OK: true, Text: "ok"},
	}
	t.Cleanup(f.stop)
	return f
}

func (f *modelFake) stop() {
	f.mu.Lock()
	closers := f.closers
	f.closers = nil
	f.mu.Unlock()
	for i := len(closers) - 1; i >= 0; i-- {
		closers[i]()
	}
}

// ready 新建一对内存管道并在另一端启动假服务，返回 supervisor 的 ready 状态。
func (f *modelFake) ready(pid int) supervisor.Status {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan struct{})
	f.mu.Lock()
	f.closers = append(f.closers,
		func() { _ = inW.Close() },
		func() { _ = outW.Close() },
		func() { close(done) },
	)
	f.mu.Unlock()
	go f.serve(inR, outW)
	return supervisor.Status{State: supervisor.StateReady, Pipe: &fakePipe{r: outR, w: inW, done: done}, PID: pid}
}

func (f *modelFake) record(method string, raw json.RawMessage) {
	params := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
	}
	f.mu.Lock()
	f.calls = append(f.calls, modelCall{Method: method, Params: params})
	f.mu.Unlock()
}

// call 返回最后一次 method 的参数；没有时返回 nil。
func (f *modelFake) call(method string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].Method == method {
			return f.calls[i].Params
		}
	}
	return nil
}

func (f *modelFake) hasCall(method string) bool { return f.call(method) != nil }

func (f *modelFake) setView(view service.ModelsView) {
	f.mu.Lock()
	f.view = view
	f.mu.Unlock()
}

func (f *modelFake) setAvailable(models []service.AvailableModel) {
	f.mu.Lock()
	f.avail = models
	f.mu.Unlock()
}

func (f *modelFake) setUsage(usage service.UsageSummary) {
	f.mu.Lock()
	f.usage = usage
	f.mu.Unlock()
}

func (f *modelFake) setDiscover(models []service.DiscoveredModel, err map[string]any) {
	f.mu.Lock()
	f.discover, f.discoverErr = models, err
	f.mu.Unlock()
}

func (f *modelFake) setTest(result service.ModelTestResult, err map[string]any) {
	f.mu.Lock()
	f.test, f.testErr = result, err
	f.mu.Unlock()
}

func (f *modelFake) setPutError(err map[string]any) {
	f.mu.Lock()
	f.putErr = err
	f.mu.Unlock()
}

func (f *modelFake) setDefaultError(err map[string]any) {
	f.mu.Lock()
	f.defaultErr = err
	f.mu.Unlock()
}

// viewJSON 是当前设置视图的 JSON；用来确认密钥不在任何响应里。
func (f *modelFake) viewJSON() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := json.Marshal(f.view)
	return string(b)
}

// provider 返回当前视图中的一个提供商。
func (f *modelFake) provider(id string) (service.ModelProvider, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.view.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return service.ModelProvider{}, false
}

func (f *modelFake) serve(in io.Reader, out io.Writer) {
	write := func(record any) {
		line, err := json.Marshal(record)
		if err != nil {
			f.t.Errorf("fake model service: %v", err)
			return
		}
		f.mu.Lock()
		_, _ = fmt.Fprintf(out, "%s\n", line)
		f.mu.Unlock()
	}
	respond := func(id json.RawMessage, result any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	fail := func(id json.RawMessage, rpcErr map[string]any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcErr})
	}
	snapshotLocked := func() service.ModelsView {
		view := f.view
		view.Providers = append([]service.ModelProvider(nil), f.view.Providers...)
		return view
	}
	snapshot := func() service.ModelsView {
		f.mu.Lock()
		defer f.mu.Unlock()
		return snapshotLocked()
	}

	br := bufio.NewReader(in)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &req) != nil || req.Method == "" {
			continue
		}
		var params map[string]any
		_ = json.Unmarshal(req.Params, &params)

		switch req.Method {
		case "conversation.list":
			respond(req.ID, map[string]any{"conversations": []any{}})
		case "models.available":
			f.mu.Lock()
			models := append([]service.AvailableModel(nil), f.avail...)
			f.mu.Unlock()
			respond(req.ID, map[string]any{"models": models})
		case "models.view":
			respond(req.ID, snapshot())
		case "usage.summary":
			f.mu.Lock()
			usage := f.usage
			f.mu.Unlock()
			respond(req.ID, usage)
		case "models.discover":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			models, discoverErr := f.discover, f.discoverErr
			f.mu.Unlock()
			if discoverErr != nil {
				fail(req.ID, discoverErr)
				continue
			}
			respond(req.ID, map[string]any{"models": models})
		case "models.test":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			result, testErr := f.test, f.testErr
			f.mu.Unlock()
			if testErr != nil {
				fail(req.ID, testErr)
				continue
			}
			respond(req.ID, result)
		case "models.putProvider":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			putErr := f.putErr
			if putErr != nil {
				f.mu.Unlock()
				fail(req.ID, putErr)
				continue
			}
			var input struct {
				Kind        string                  `json:"kind"`
				ID          string                  `json:"id"`
				Name        string                  `json:"name"`
				BaseURL     string                  `json:"baseUrl"`
				RequiresKey bool                    `json:"requiresKey"`
				Enabled     bool                    `json:"enabled"`
				Models      []service.ProviderModel `json:"models"`
			}
			_ = json.Unmarshal(req.Params, &input)
			existing, hasStoredKey := service.ModelProvider{}, false
			for _, p := range f.view.Providers {
				if p.ID == input.ID {
					existing, hasStoredKey = p, p.HasStoredKey
				}
			}
			if input.Name == "" {
				input.Name = existing.Name
			}
			keyRequired := input.RequiresKey
			if input.Kind == "builtin" {
				keyRequired = true
				if input.Name == "" {
					input.Name = input.ID
				}
			}
			provider := service.ModelProvider{
				Kind:         input.Kind,
				ID:           input.ID,
				Name:         input.Name,
				BaseURL:      input.BaseURL,
				RequiresKey:  input.RequiresKey,
				KeyRequired:  keyRequired,
				Enabled:      input.Enabled,
				HasStoredKey: hasStoredKey,
				Models:       input.Models,
			}
			providers := make([]service.ModelProvider, 0, len(f.view.Providers)+1)
			for _, p := range f.view.Providers {
				if p.ID != provider.ID {
					providers = append(providers, p)
				}
			}
			f.view.Providers = append(providers, provider)
			view := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, view)
		case "models.setKey":
			f.record(req.Method, req.Params)
			id, _ := params["providerId"].(string)
			f.mu.Lock()
			for i := range f.view.Providers {
				if f.view.Providers[i].ID == id {
					f.view.Providers[i].HasStoredKey = true
				}
			}
			view := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, view)
		case "models.clearKey":
			f.record(req.Method, req.Params)
			id, _ := params["providerId"].(string)
			f.mu.Lock()
			for i := range f.view.Providers {
				if f.view.Providers[i].ID == id {
					f.view.Providers[i].HasStoredKey = false
				}
			}
			view := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, view)
		case "models.deleteProvider":
			f.record(req.Method, req.Params)
			id, _ := params["id"].(string)
			f.mu.Lock()
			providers := make([]service.ModelProvider, 0, len(f.view.Providers))
			for _, p := range f.view.Providers {
				if p.ID != id {
					providers = append(providers, p)
				}
			}
			f.view.Providers = providers
			if f.view.DefaultModel != nil && f.view.DefaultModel.Provider == id {
				f.view.DefaultModel = nil
			}
			view := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, view)
		case "models.setDefault":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			defaultErr := f.defaultErr
			if defaultErr != nil {
				f.mu.Unlock()
				fail(req.ID, defaultErr)
				continue
			}
			var input struct {
				Model         *service.ModelRef `json:"model"`
				ThinkingLevel *string           `json:"thinkingLevel"`
			}
			_ = json.Unmarshal(req.Params, &input)
			f.view.DefaultModel, f.view.DefaultThinking = input.Model, input.ThinkingLevel
			view := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, view)
		default:
			fail(req.ID, map[string]any{"code": -32601, "message": "method not found: " + req.Method})
		}
	}
}

// openSettings 启动假服务并打开设置页。
func openSettings(t *testing.T, f *modelFake, width, height int) (*app, *uiQueue, *ui.Tester) {
	t.Helper()
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, width, height)
	a.onService(f.ready(51))
	if err := tt.Click("Settings"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the settings", func() bool { return a.st.loaded && a.st.view != nil })
	return a, q, tt
}

func TestSettingsListsProvidersModelsAndUsage(t *testing.T) {
	f := newModelFake(t)
	f.setView(service.ModelsView{
		CredentialBackend: "file",
		Providers: []service.ModelProvider{
			{
				Kind: "custom", ID: "custom-acme", Name: "Acme", BaseURL: "https://acme.test/v1",
				RequiresKey: true, KeyRequired: true, Enabled: true, HasStoredKey: true,
				Models: []service.ProviderModel{
					{ID: "gpt-a", Name: "GPT A", ContextWindow: 128_000, MaxTokens: 8_000, Reasoning: true},
					{ID: "gpt-b", Name: "GPT B", ContextWindow: 32_000, MaxTokens: 4_000},
				},
			},
			{Kind: "builtin", ID: "deepseek", Name: "DeepSeek", KeyRequired: true, Enabled: false},
		},
	})
	f.setAvailable([]service.AvailableModel{
		{Provider: "custom-acme", ID: "gpt-a", Name: "GPT A", ContextWindow: 128_000, MaxTokens: 8_000, Reasoning: true, ThinkingLevels: []string{"off", "low", "high"}},
		{Provider: "deepseek", ID: "deepseek-chat", Name: "DeepSeek Chat", ContextWindow: 64_000, MaxTokens: 8_000, ThinkingLevels: []string{"off"}},
	})
	f.setUsage(service.UsageSummary{
		Models: map[string]service.Usage{
			"custom-acme/gpt-a": {Input: 100, Output: 20, CacheRead: 7, TotalTokens: 120, Cost: service.UsageCost{Total: 0.25}},
		},
		Tools: map[string]service.Usage{
			"describe_table": {Input: 50, Output: 20, CacheRead: 3, TotalTokens: 70},
		},
	})

	a, q, tt := openSettings(t, f, 1400, 2200)
	q.pump(t, tt, "usage", func() bool { return a0UsageLoaded(f) })

	expectTexts(t, tt, []string{
		"Model providers", "Acme", "https://acme.test/v1", "API key stored",
		"Show models for Acme (2)", "DeepSeek", "No API key",
		"Default model", "Usage", "Input tokens", "Output tokens", "Cache hits",
		"150", "40", "10", "190", "$0.25",
	}, nil)

	if err := tt.Click("Enable provider DeepSeek"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the enabled provider", func() bool {
		p, ok := f.provider("deepseek")
		return ok && p.Enabled && !a.st.loading
	})
	put := f.call("models.putProvider")
	if put == nil || put["kind"] != "builtin" || put["id"] != "deepseek" || put["enabled"] != true {
		t.Errorf("models.putProvider params: %v", put)
	}

	if err := tt.Click("Show models for Acme (2)"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"gpt-a", "GPT A", "128k", "8k", "32k", "4k", "reasoning"}, nil)

	if err := tt.Click("Show models for DeepSeek (1)"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"deepseek-chat", "DeepSeek Chat", "64k"}, nil)
}

// a0UsageLoaded 是列表测试的等待条件：用量卡已有数据。
func a0UsageLoaded(f *modelFake) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.usage.Models) > 0
}

func TestSettingsDiscoversAndSavesProviderWithoutEchoingKeys(t *testing.T) {
	f := newModelFake(t)
	f.setView(service.ModelsView{
		CredentialBackend: "file",
		Presets: []service.ProviderPreset{
			{PresetID: "ollama", Name: "Ollama", BaseURL: "http://localhost:11434/v1"},
			{PresetID: "magpie", Name: "Magpie 本地网关", BaseURL: "http://127.0.0.1:3425/v1"},
		},
	})
	f.setDiscover([]service.DiscoveredModel{
		{ProviderModel: service.ProviderModel{ID: "gw/flash", Name: "Flash", ContextWindow: 512_000, MaxTokens: 384_000, Reasoning: true, Vision: true}},
		{ProviderModel: service.ProviderModel{ID: "gw/plain", Name: "Plain", ContextWindow: 32_768, MaxTokens: 4_096}, Inferred: true},
	}, nil)

	a, q, tt := openSettings(t, f, 1400, 2400)
	const secret = "sk-draft-secret"

	if err := tt.Click("Add provider"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Endpoint preset"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Magpie local gateway"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the preset fields", func() bool {
		return a.st.editing != nil && a.st.editing.baseURL == "http://127.0.0.1:3425/v1"
	})
	expectTexts(t, tt, []string{"Provider id", "Requires an API key"}, nil)
	if a.st.editing.id != "custom-magpie" {
		t.Errorf("preset provider id %q, want custom-magpie", a.st.editing.id)
	}

	if err := tt.Click("API key"); err != nil {
		t.Fatal(err)
	}
	tt.Type(secret)
	if got := a.st.editing.key; got != secret {
		t.Fatalf("the API key field holds %q, want the typed key", got)
	}
	if strings.Contains(strings.Join(tt.Texts(), "\n"), secret) {
		t.Fatal("the password field showed the API key")
	}

	if err := tt.Click("Discover models"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the discovered models", func() bool {
		return a.st.editing != nil && !a.st.discovering && len(a.st.editing.models) == 2
	})
	expectTexts(t, tt, []string{"Found 2 models", "Some models did not report their context length", "context inferred", "32.8k", "4.1k"}, nil)

	// 只启用 gw/flash；gw/plain 的上限是推断值，取消掉。
	if err := tt.Click("Use gw/plain"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.st.editing.include["gw/plain"] {
		t.Fatal("unchecking a model left it enabled")
	}

	if err := tt.Click("Test gw/flash"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the model test", func() bool { return !a.st.testBusy && a.st.testMsg != "" })
	expectTexts(t, tt, []string{"Test passed"}, nil)
	testParams := f.call("models.test")
	if testParams == nil || testParams["apiKey"] != secret {
		t.Fatalf("models.test params %v, want the typed key", testParams)
	}
	provider := testParams["provider"].(map[string]any)
	if provider["baseUrl"] != "http://127.0.0.1:3425/v1" || provider["id"] != "custom-magpie" ||
		provider["kind"] != "custom" || provider["requiresKey"] != false {
		t.Errorf("the draft provider sent to models.test: %v", provider)
	}

	if err := tt.Click("Save provider"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the saved provider", func() bool {
		return a.st.editing == nil && !a.st.loading && hasProvider(f, "custom-magpie")
	})
	if err := tt.Click("Show models for Magpie local gateway (1)"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"gw/flash", "512k", "384k", "reasoning", "vision", "API key stored"}, []string{secret})

	put := f.call("models.putProvider")
	if put == nil {
		t.Fatal("no models.putProvider call")
	}
	if put["kind"] != "custom" || put["id"] != "custom-magpie" || put["name"] != "Magpie local gateway" ||
		put["baseUrl"] != "http://127.0.0.1:3425/v1" || put["requiresKey"] != false || put["enabled"] != true {
		t.Errorf("models.putProvider params: %v", put)
	}
	models, _ := put["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("saved %d models, want only the checked one: %v", len(models), put["models"])
	}
	model := models[0].(map[string]any)
	if model["id"] != "gw/flash" || model["contextWindow"] != float64(512_000) || model["maxTokens"] != float64(384_000) || model["reasoning"] != true {
		t.Errorf("saved model: %v", model)
	}
	if _, ok := put["apiKey"]; ok {
		t.Error("models.putProvider carried an apiKey")
	}

	setKey := f.call("models.setKey")
	if setKey == nil || setKey["providerId"] != "custom-magpie" || setKey["apiKey"] != secret {
		t.Fatalf("models.setKey params: %v", setKey)
	}
	if strings.Contains(f.viewJSON(), secret) || strings.Contains(strings.Join(tt.Texts(), "\n"), secret) {
		t.Error("the stored key came back to the interface")
	}
	if a.st.editing != nil {
		t.Errorf("the editor is still open after saving: %+v", a.st.editing)
	}
}

func hasProvider(f *modelFake, id string) bool {
	_, ok := f.provider(id)
	return ok
}

func TestSettingsKeyEditorWritesButNeverReads(t *testing.T) {
	f := newModelFake(t)
	f.setView(service.ModelsView{
		CredentialBackend: "file",
		Providers: []service.ModelProvider{{
			Kind: "custom", ID: "custom-acme", Name: "Acme", BaseURL: "https://acme.test/v1",
			RequiresKey: true, KeyRequired: true, Enabled: true,
			Models: []service.ProviderModel{{ID: "gpt-a", ContextWindow: 128_000, MaxTokens: 8_000}},
		}},
	})
	f.setAvailable([]service.AvailableModel{{Provider: "custom-acme", ID: "gpt-a", ContextWindow: 128_000, MaxTokens: 8_000, ThinkingLevels: []string{"off"}}})

	a, q, tt := openSettings(t, f, 1400, 2200)
	expectTexts(t, tt, []string{"No API key"}, nil)

	providerAction(t, tt, "Acme", "Set key")
	tt.Frame()
	const secret = "sk-live-secret"
	if err := tt.Click("API key for Acme"); err != nil {
		t.Fatal(err)
	}
	tt.Type(secret)
	if strings.Contains(strings.Join(tt.Texts(), "\n"), secret) {
		t.Fatal("the key editor showed the typed key")
	}
	if err := tt.Click("Save key"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the stored key", func() bool {
		p, ok := f.provider("custom-acme")
		return ok && p.HasStoredKey && !a.st.loading && a.st.keyProvider == ""
	})
	expectTexts(t, tt, []string{"API key stored", "API key stored for Acme."}, []string{secret})
	if a.st.keyInput != "" {
		t.Errorf("the key input still holds %q after saving", a.st.keyInput)
	}
	if setKey := f.call("models.setKey"); setKey == nil || setKey["apiKey"] != secret {
		t.Fatalf("models.setKey params: %v", setKey)
	}
	if strings.Contains(f.viewJSON(), secret) {
		t.Error("the service view contains the key")
	}

	providerAction(t, tt, "Acme", "Clear key")
	tt.Frame()
	if err := tt.Click("Confirm clear key"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the cleared key", func() bool {
		p, ok := f.provider("custom-acme")
		return ok && !p.HasStoredKey && !a.st.loading
	})
	expectTexts(t, tt, []string{"No API key"}, nil)
	// 密钥清掉之后，「⋯」菜单里不再有「Clear key」。
	if err := tt.Click("Actions for Acme"); err != nil {
		t.Fatal(err)
	}
	for _, item := range tt.Menu() {
		if item == "Clear key" {
			t.Error("the menu still offers Clear key")
		}
	}
	tt.CloseMenu()
	if !f.hasCall("models.clearKey") {
		t.Error("no models.clearKey call")
	}
}

func TestSettingsDefaultModelAndThinkingLevel(t *testing.T) {
	f := newModelFake(t)
	f.setView(service.ModelsView{
		CredentialBackend: "file",
		Providers: []service.ModelProvider{{
			Kind: "custom", ID: "custom-acme", Name: "Acme", BaseURL: "https://acme.test/v1",
			RequiresKey: false, KeyRequired: false, Enabled: true,
			Models: []service.ProviderModel{
				{ID: "gpt-a", ContextWindow: 128_000, MaxTokens: 8_000, Reasoning: true},
				{ID: "gpt-b", ContextWindow: 32_000, MaxTokens: 4_000},
			},
		}},
	})
	f.setAvailable([]service.AvailableModel{
		{Provider: "custom-acme", ID: "gpt-a", Name: "GPT A", ContextWindow: 128_000, MaxTokens: 8_000, Reasoning: true, ThinkingLevels: []string{"off", "low", "high"}},
		{Provider: "custom-acme", ID: "gpt-b", Name: "GPT B", ContextWindow: 32_000, MaxTokens: 4_000, ThinkingLevels: []string{"off"}},
	})

	a, q, tt := openSettings(t, f, 1400, 2400)

	if err := tt.Click("Choose default model"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("custom-acme/gpt-a"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the chosen model", func() bool { return a.st.defChoice == "custom-acme/gpt-a" })

	if err := tt.Click("Choose thinking level"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("high"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the thinking level", func() bool { return a.st.defThinking == "high" })

	q.pump(t, tt, "the saved default", func() bool {
		return a.st.view != nil && a.st.view.DefaultModel != nil && !a.st.defBusy
	})
	params := f.call("models.setDefault")
	if params == nil {
		t.Fatal("no models.setDefault call")
	}
	model, _ := params["model"].(map[string]any)
	if model["provider"] != "custom-acme" || model["modelId"] != "gpt-a" || params["thinkingLevel"] != "high" {
		t.Errorf("models.setDefault params: %v", params)
	}
	expectTexts(t, tt, []string{"Default model saved."}, nil)

	// 换到不支持 high 的模型：思考强度回到默认。
	if err := tt.Click("Choose default model"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("custom-acme/gpt-b"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the second model", func() bool { return a.st.defChoice == "custom-acme/gpt-b" && a.st.defThinking == "" })
}

func TestSettingsShowsActionableErrors(t *testing.T) {
	f := newModelFake(t)
	f.setView(service.ModelsView{
		CredentialBackend: "file",
		Presets:           []service.ProviderPreset{{PresetID: "ollama", Name: "Ollama", BaseURL: "http://localhost:11434/v1"}},
	})
	f.setDiscover(nil, map[string]any{"code": -32603, "message": "fetch failed"})

	a, q, tt := openSettings(t, f, 1400, 2400)
	if err := tt.Click("Add provider"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Endpoint preset"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Ollama"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the ollama preset", func() bool { return a.st.editing != nil && a.st.editing.baseURL != "" })
	if err := tt.Click("Discover models"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the discover error", func() bool { return !a.st.discovering && a.st.discoverErr != "" })
	expectTexts(t, tt, []string{"Could not reach http://localhost:11434/v1", "is the local gateway (or Ollama) running"}, nil)

	// 端点拒绝鉴权：测试按钮给出「补密钥」的提示。
	f.setDiscover([]service.DiscoveredModel{{ProviderModel: service.ProviderModel{ID: "llama", Name: "Llama", ContextWindow: 32_000, MaxTokens: 4_000}}}, nil)
	f.setTest(service.ModelTestResult{OK: false, Error: "HTTP 401 Unauthorized"}, nil)
	if err := tt.Click("Discover models"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "one discovered model", func() bool {
		return a.st.editing != nil && !a.st.discovering && len(a.st.editing.models) == 1
	})
	if err := tt.Click("Test llama"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the rejected test", func() bool { return !a.st.testBusy && a.st.testMsg != "" })
	expectTexts(t, tt, []string{"Set the API key for this provider", "401"}, nil)

	// 保存被服务拒绝：把 invalid_input 的原文给出来。
	f.setPutError(map[string]any{"code": -32602, "message": "custom provider id must match custom-[a-z0-9-]", "data": map[string]any{"kind": "invalid_input"}})
	if err := tt.Click("Save provider"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the rejected save", func() bool { return !a.st.saveBusy && a.st.formErr != "" })
	expectTexts(t, tt, []string{"The service rejected this setting", "custom provider id"}, nil)

	// 默认模型的 unknown_model 提示。
	a.closeEditor()
	f.setAvailable([]service.AvailableModel{{Provider: "custom-ollama2", ID: "m", ContextWindow: 32_000, MaxTokens: 4_000, ThinkingLevels: []string{"off"}}})
	f.setDefaultError(map[string]any{"code": -32602, "message": "unknown model: custom-ollama2/m", "data": map[string]any{"kind": "unknown_model"}})
	a.loadSettings()
	q.pump(t, tt, "the available models", func() bool { return len(a.st.available) == 1 && !a.st.loading })
	if err := tt.Click("Choose default model"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("custom-ollama2/m"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the chosen model", func() bool { return a.st.defChoice == "custom-ollama2/m" })
	q.pump(t, tt, "the default error", func() bool { return !a.st.defBusy && a.st.defErr != "" })
	expectTexts(t, tt, []string{"The service does not know this model"}, nil)
}

// providerAction 打开提供方卡片的「⋯」菜单并选一项。
func providerAction(t *testing.T, tt *ui.Tester, provider, item string) {
	t.Helper()
	if err := tt.Click("Actions for " + provider); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem(item); err != nil {
		t.Fatalf("%v; menu %q", err, tt.Menu())
	}
	tt.Frame()
}
