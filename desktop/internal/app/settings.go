package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// settingsState 是设置页的数据与编辑状态。只有 UI 线程会改它：构建视图时，以及在 post 上排队的函数里。
type settingsState struct {
	// accentOpen 与 accentPick 是外观页「自定义强调色」取色器的弹层与正在挑的颜色。
	accentOpen bool
	accentPick ui.Color
	gen        int // 丢弃旧加载的结果
	loading    bool
	loaded     bool
	err        string

	view         *service.ModelsView
	available    []service.AvailableModel
	availableErr string
	usage        *service.UsageSummary
	usageErr     string

	// expanded 记录展开模型清单的提供商。
	expanded map[string]bool
	// 确认对话框：删除提供商与清除密钥都要在 Modal 里再确认一次。
	modalOpen       bool
	confirmKind     string // "remove" 或 "clear-key"
	confirmProvider string
	notice          string // 最近一次操作的提示，显示成 toast
	noticeErr       bool   // notice 是失败提示
	// tab 是设置页的分区：0 是模型与用量，1 是通用（外观、语言、文件）。
	tab int

	// 密钥编辑：永远只写不读；保存后清空输入框。
	keyProvider string
	keyInput    string
	keyErr      string
	keyBusy     bool

	// 默认模型表单。
	defChoice   string
	defThinking string
	defBusy     bool
	defErr      string

	// 新增/编辑提供商。
	editing      *providerDraft
	presetChoice string
	formErr      string
	discovering  bool
	discoverErr  string
	saveBusy     bool
	testBusy     bool
	testMsg      string
}

// providerDraft 是「新增 / 编辑提供商」表单的内容。API key 只存在于输入框里，保存后立刻清空；
// 已保存的密钥永远不回到界面。
type providerDraft struct {
	existing    bool
	id          string
	name        string
	baseURL     string
	requiresKey bool
	idTouched   bool
	key         string
	models      []service.ProviderModel
	include     map[string]bool
	inferred    map[string]bool
}

// settingsPageLabel 是默认模型下拉框里「不指定」的选项。
const settingsPageLabel = "Service default (first available model)"

// defaultThinkingLabel 是思考强度下拉框里「跟随模型」的选项。
const defaultThinkingLabel = "Default"

// loadSettings 只刷新设置页需要的数据（模型设置、可用模型、用量），不重建窗口，也不影响正在显示的会话。
func (a *app) loadSettings() {
	client := a.client
	if client == nil {
		return
	}
	a.st.gen++
	gen := a.st.gen
	a.st.loading = true
	a.st.err = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, viewErr := client.ModelsView(ctx)
		available, availableErr := client.AvailableModels(ctx)
		usage, usageErr := client.UsageSummary(ctx)
		a.post(func() {
			if client != a.client || gen != a.st.gen {
				return
			}
			a.st.loading = false
			a.st.loaded = true
			if availableErr != nil {
				a.st.availableErr = settingsErrorText(availableErr)
			} else {
				a.st.available, a.st.availableErr = available, ""
				// 聊天里的模型下拉框用同一份目录：在设置里加了提供商、改了启用状态或默认模型后，不必重启就能选到。
				a.cv.models, a.cv.modelsErr = available, ""
			}
			if viewErr != nil {
				a.st.err = settingsErrorText(viewErr)
			} else {
				a.st.view = view
				a.syncDefaultForm(view)
			}
			if usageErr != nil {
				a.st.usageErr = settingsErrorText(usageErr)
			} else {
				a.st.usage, a.st.usageErr = usage, ""
				a.ensureExpanded()
			}
		})
	}()
}

// ensureExpanded 给展开表一个可写的 map。
func (a *app) ensureExpanded() {
	if a.st.expanded == nil {
		a.st.expanded = map[string]bool{}
	}
}

func (a *app) isExpanded(id string) bool {
	return a.st.expanded[id]
}

func (a *app) setExpanded(id string, on bool) {
	a.ensureExpanded()
	if on {
		a.st.expanded[id] = true
	} else {
		delete(a.st.expanded, id)
	}
}

// syncDefaultForm 用服务返回的默认模型重置下拉框。可用模型列表可能比保存的默认模型晚到，所以先保存
// 选择标签；标签不在可选项里时显示为空，由服务在下次保存前保留原设置。
func (a *app) syncDefaultForm(view *service.ModelsView) {
	a.st.defChoice = ""
	if view.DefaultModel != nil {
		label := view.DefaultModel.Provider + "/" + view.DefaultModel.ModelID
		for _, m := range a.st.available {
			if m.Provider == view.DefaultModel.Provider && m.ID == view.DefaultModel.ModelID {
				a.st.defChoice = label
				break
			}
		}
	}
	a.st.defThinking = ""
	if view.DefaultThinking != nil {
		a.st.defThinking = *view.DefaultThinking
	}
}

// settingsTabGeneral 与 settingsTabAppearance 是设置页「通用」与「外观」分区的索引（0 是模型）。
const (
	settingsTabGeneral      = 1
	settingsTabAppearance   = 2
	settingsTabIntegrations = 3
)

// settingsModelRow 是 provider 模型表与可用模型表共用的行。
type settingsModelRow struct {
	ID            string
	Name          string
	ContextWindow int
	MaxTokens     int
	Reasoning     bool
	Vision        bool
	Levels        []string
}

// defThinkingForChoice 在换模型后丢掉该模型不支持的思考强度。
func (a *app) defThinkingForChoice() {
	if a.st.defThinking == "" {
		return
	}
	m := a.selectedDefaultModel()
	if m == nil {
		a.st.defThinking = ""
		return
	}
	for _, level := range m.ThinkingLevels {
		if level == a.st.defThinking {
			return
		}
	}
	a.st.defThinking = ""
}

func (a *app) selectedDefaultModel() *service.AvailableModel {
	if a.st.defChoice == "" {
		return nil
	}
	for i := range a.st.available {
		if modelLabel(a.st.available[i]) == a.st.defChoice {
			return &a.st.available[i]
		}
	}
	return nil
}

func (a *app) providerByID(id string) (service.ModelProvider, bool) {
	if a.st.view == nil {
		return service.ModelProvider{}, false
	}
	for _, p := range a.st.view.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return service.ModelProvider{}, false
}

// --- 操作 ---

func (a *app) setProviderEnabled(p service.ModelProvider, on bool) {
	client := a.client
	if client == nil {
		return
	}
	settings := providerSettings(p)
	settings.Enabled = on
	a.st.notice = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := client.PutProvider(ctx, settings)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.st.notice, a.st.noticeErr = "Could not change "+p.Name+": "+settingsErrorText(err), true
				return
			}
			a.st.notice, a.st.noticeErr = p.Name+" is now "+enabledWord(on)+".", false
			a.loadSettings()
		})
	}()
}

func (a *app) saveProviderKey(p service.ModelProvider) {
	client := a.client
	key := strings.TrimSpace(a.st.keyInput)
	if client == nil {
		return
	}
	if key == "" {
		a.st.keyErr = "Enter an API key first."
		return
	}
	a.st.keyBusy, a.st.keyErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := client.SetProviderKey(ctx, p.ID, key)
		a.post(func() {
			if client != a.client {
				return
			}
			a.st.keyBusy = false
			if err != nil {
				a.st.keyErr = "Could not store the key: " + settingsErrorText(err)
				return
			}
			// 密钥只写不读：输入框立刻清空，界面只用 hasStoredKey 表示状态。
			a.st.keyProvider, a.st.keyInput = "", ""
			a.st.notice, a.st.noticeErr = "API key stored for "+p.Name+".", false
			a.loadSettings()
		})
	}()
}

func (a *app) clearProviderKey(p service.ModelProvider) {
	client := a.client
	if client == nil {
		return
	}
	a.st.notice = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := client.ClearProviderKey(ctx, p.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.st.notice, a.st.noticeErr = "Could not clear the key for "+p.Name+": "+settingsErrorText(err), true
				return
			}
			a.st.notice, a.st.noticeErr = "API key cleared for "+p.Name+".", false
			a.loadSettings()
		})
	}()
}

func (a *app) removeProvider(p service.ModelProvider) {
	client := a.client
	if client == nil {
		return
	}
	a.st.notice = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := client.DeleteProvider(ctx, p.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.st.notice, a.st.noticeErr = "Could not remove "+p.Name+": "+settingsErrorText(err), true
				return
			}
			if a.st.keyProvider == p.ID {
				a.st.keyProvider, a.st.keyInput, a.st.keyErr = "", "", ""
			}
			a.st.notice, a.st.noticeErr = p.Name+" removed.", false
			a.loadSettings()
		})
	}()
}

func (a *app) saveDefaultModel() {
	client := a.client
	if client == nil {
		return
	}
	var ref *service.ModelRef
	if a.st.defChoice != "" {
		m := a.selectedDefaultModel()
		if m == nil {
			a.st.defErr = "Choose a model that is currently available."
			return
		}
		ref = &service.ModelRef{Provider: m.Provider, ModelID: m.ID}
	}
	var thinking *string
	if ref != nil && a.st.defThinking != "" {
		level := a.st.defThinking
		thinking = &level
	}
	a.st.defBusy, a.st.defErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := client.SetDefaultModel(ctx, ref, thinking)
		a.post(func() {
			if client != a.client {
				return
			}
			a.st.defBusy = false
			if err != nil {
				a.st.defErr = settingsErrorText(err)
				return
			}
			a.st.notice, a.st.noticeErr = "Default model saved.", false
			a.loadSettings()
		})
	}()
}

func (a *app) startAddProvider() {
	a.st.editing = &providerDraft{
		include:  map[string]bool{},
		inferred: map[string]bool{},
	}
	a.st.presetChoice, a.st.formErr, a.st.discoverErr = "", "", ""
	a.st.testMsg = ""
	a.st.testBusy, a.st.saveBusy, a.st.discovering = false, false, false
	a.st.notice = ""
}

// applyPreset 把预设填进表单；已经手改过的 provider id 不覆盖。
func (a *app) applyPreset(label string) {
	d := a.st.editing
	if d == nil || a.st.view == nil {
		return
	}
	a.st.presetChoice = label
	if label == "Custom endpoint" {
		return
	}
	for _, p := range a.st.view.Presets {
		if presetLabel(p) != label {
			continue
		}
		d.name = label
		d.baseURL = p.BaseURL
		d.requiresKey = p.RequiresKey
		if !d.idTouched {
			d.id = uniqueProviderID(a, p.PresetID)
		}
		return
	}
}

func (a *app) startEditProvider(p service.ModelProvider) {
	d := &providerDraft{
		existing:    true,
		id:          p.ID,
		name:        p.Name,
		baseURL:     p.BaseURL,
		requiresKey: p.RequiresKey || p.KeyRequired,
		idTouched:   true,
		models:      append([]service.ProviderModel(nil), p.Models...),
		include:     map[string]bool{},
		inferred:    map[string]bool{},
	}
	for _, m := range p.Models {
		d.include[m.ID] = true
	}
	a.st.editing = d
	a.st.presetChoice, a.st.formErr, a.st.discoverErr = "", "", ""
	a.st.testMsg = ""
	a.st.testBusy, a.st.saveBusy, a.st.discovering = false, false, false
	a.st.notice = ""
	a.st.keyProvider = ""
}

func (a *app) closeEditor() {
	a.st.editing = nil
	a.st.presetChoice, a.st.formErr, a.st.discoverErr = "", "", ""
	a.st.testMsg = ""
	a.st.saveBusy, a.st.testBusy, a.st.discovering = false, false, false
}

func (a *app) discoverModels() {
	d := a.st.editing
	client := a.client
	if d == nil || client == nil {
		return
	}
	if strings.TrimSpace(d.baseURL) == "" {
		a.st.discoverErr = "Enter the endpoint's base URL first."
		return
	}
	a.st.discovering, a.st.discoverErr, a.st.testMsg = true, "", ""
	baseURL, apiKey := d.baseURL, d.key
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		models, err := client.DiscoverModels(ctx, baseURL, apiKey)
		a.post(func() {
			if client != a.client || a.st.editing != d {
				return
			}
			a.st.discovering = false
			if err != nil {
				a.st.discoverErr = discoverErrorText(baseURL, err)
				return
			}
			if len(models) == 0 {
				a.st.discoverErr = "The endpoint listed no models. Check the base URL (usually it ends in /v1) and whether this service exposes a model list."
				return
			}
			d.models = make([]service.ProviderModel, 0, len(models))
			d.include = map[string]bool{}
			d.inferred = map[string]bool{}
			for _, m := range models {
				d.models = append(d.models, m.ProviderModel)
				d.include[m.ID] = true
				if m.Inferred {
					d.inferred[m.ID] = true
				}
			}
			a.st.notice, a.st.noticeErr = fmt.Sprintf("Found %d models. Choose the ones to enable, then save.", len(models)), false
		})
	}()
}

func (a *app) testDraftModel(modelID string) {
	d := a.st.editing
	client := a.client
	if d == nil || client == nil {
		return
	}
	settings := draftSettings(d)
	a.st.testBusy = true
	a.st.testMsg, a.st.formErr = "", ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		result, err := client.TestModel(ctx, service.ModelRef{Provider: d.id, ModelID: modelID}, &settings, d.key)
		a.post(func() {
			if client != a.client || a.st.editing != d {
				return
			}
			a.st.testBusy = false
			if err != nil {
				a.st.testMsg = "Could not test " + modelID + ": " + settingsErrorText(err)
				return
			}
			if !result.OK {
				a.st.testMsg = testErrorText(d.baseURL, result.Error)
				return
			}
			text := strings.TrimSpace(result.Text)
			if text == "" {
				text = "(empty reply)"
			}
			a.st.testMsg = "Test passed: the model replied " + strconv.Quote(text) + "."
		})
	}()
}

func (a *app) saveProvider() {
	d := a.st.editing
	client := a.client
	if d == nil || client == nil {
		return
	}
	settings := draftSettings(d)
	models := make([]service.ProviderModel, 0, len(d.models))
	for _, m := range d.models {
		if d.include[m.ID] {
			models = append(models, m)
		}
	}
	if len(models) == 0 {
		a.st.formErr = "Choose at least one model: discover the endpoint and tick the models to enable."
		return
	}
	settings.Models = models
	key := strings.TrimSpace(d.key)
	a.st.saveBusy, a.st.formErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.PutProvider(ctx, settings)
		var keyErr error
		if err == nil && key != "" {
			_, keyErr = client.SetProviderKey(ctx, settings.ID, key)
		}
		a.post(func() {
			if client != a.client {
				return
			}
			a.st.saveBusy = false
			if err != nil {
				if a.st.editing == d {
					a.st.formErr = settingsErrorText(err)
				}
				return
			}
			if keyErr != nil {
				a.st.notice, a.st.noticeErr = "Provider saved, but the API key was not stored: "+settingsErrorText(keyErr), true
			} else {
				a.st.notice, a.st.noticeErr = settings.Name+" saved.", false
			}
			a.closeEditor()
			a.loadSettings()
		})
	}()
}

// --- 纯函数 ---

func providerSettings(p service.ModelProvider) service.ProviderSettings {
	return service.ProviderSettings{
		Kind:        p.Kind,
		ID:          p.ID,
		Name:        p.Name,
		BaseURL:     p.BaseURL,
		RequiresKey: p.RequiresKey,
		Enabled:     p.Enabled,
		Models:      append([]service.ProviderModel(nil), p.Models...),
	}
}

func draftSettings(d *providerDraft) service.ProviderSettings {
	return service.ProviderSettings{
		Kind:        "custom",
		ID:          strings.TrimSpace(d.id),
		Name:        strings.TrimSpace(d.name),
		BaseURL:     strings.TrimSpace(d.baseURL),
		RequiresKey: d.requiresKey,
		Enabled:     true,
		Models:      append([]service.ProviderModel(nil), d.models...),
	}
}

func keyStatus(p service.ModelProvider) string {
	switch {
	case p.HasStoredKey:
		return "API key stored"
	case !p.KeyRequired:
		return "No key needed"
	default:
		return "No API key"
	}
}

func presetLabel(p service.ProviderPreset) string {
	switch p.PresetID {
	case "ollama":
		return "Ollama"
	case "magpie":
		return "Magpie local gateway"
	case "atlascloud":
		return "AtlasCloud"
	}
	if p.Name != "" {
		return p.Name
	}
	return p.PresetID
}

func modelLabel(m service.AvailableModel) string { return m.Provider + "/" + m.ID }

func enabledWord(on bool) string {
	if on {
		return "enabled"
	}
	return "disabled"
}

func anyInferred(d *providerDraft) bool {
	for id, inferred := range d.inferred {
		if inferred && d.include[id] {
			return true
		}
	}
	return false
}

func formatCount(n int) string {
	switch {
	case n >= 1_000_000:
		return trimDecimal(float64(n)/1_000_000) + "M"
	case n >= 1_000:
		return trimDecimal(float64(n)/1_000) + "k"
	}
	return strconv.Itoa(n)
}

// trimDecimal 保留最多一位小数：512000 → 512k，32768 → 32.8k。
func trimDecimal(v float64) string {
	return strings.TrimSuffix(strconv.FormatFloat(v, 'f', 1, 64), ".0")
}

// usageTotals 把按模型和按工具分桶的用量加成一个总数。
func usageTotals(u *service.UsageSummary) service.Usage {
	var total service.Usage
	for _, usage := range u.Models {
		addUsage(&total, usage)
	}
	for _, usage := range u.Tools {
		addUsage(&total, usage)
	}
	return total
}

func addUsage(total *service.Usage, u service.Usage) {
	total.Input += u.Input
	total.Output += u.Output
	total.CacheRead += u.CacheRead
	total.CacheWrite += u.CacheWrite
	total.TotalTokens += u.TotalTokens
	total.Cost.Input += u.Cost.Input
	total.Cost.Output += u.Cost.Output
	total.Cost.CacheRead += u.Cost.CacheRead
	total.Cost.CacheWrite += u.Cost.CacheWrite
	total.Cost.Total += u.Cost.Total
}

// settingsErrorText 把设置方法的 RPC 错误翻成用户可读的提示；未知模型与不支持的思考强度分开说明。
func settingsErrorText(err error) string {
	var e *service.Error
	if errors.As(err, &e) {
		switch e.Kind {
		case "invalid_input":
			lower := strings.ToLower(e.Message)
			if strings.Contains(lower, "contextwindow") || strings.Contains(lower, "maxtokens") {
				return "The model's context window or output limit is not valid: " + e.Message + ". Both must be positive, and max output cannot exceed the context window."
			}
			return "The service rejected this setting: " + e.Message
		case "unknown_model":
			return "The service does not know this model: " + e.Message
		case "unsupported_thinking_level":
			return "This model does not support that thinking level: " + e.Message
		}
		switch e.Code {
		case -32601:
			return "This service build has no model settings (method not found)."
		case -32000:
			return "The service could not apply the change: " + e.Message
		case -32603:
			return "The service failed while applying the change: " + e.Message
		}
	}
	if errors.Is(err, service.ErrClosed) {
		return "The agent service is not running."
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "The service did not answer in time."
	}
	return err.Error()
}

// discoverErrorText 给「从端点发现模型」的失败补一句可操作的提示。服务端把连接失败报成内部错误，
// 把 HTTP 状态放在 SettingsError 的文案里。
func discoverErrorText(baseURL string, err error) string {
	var e *service.Error
	text := err.Error()
	message := ""
	code := 0
	if errors.As(err, &e) {
		code, message = e.Code, e.Message
	}
	lower := strings.ToLower(message)
	switch {
	case code == -32603:
		return "Could not reach " + baseURL + ": is the local gateway (or Ollama) running at that address? Check the base URL and try again."
	case strings.Contains(lower, "http 401"), strings.Contains(lower, "http 403"):
		return "The endpoint refused the request (" + message + "). Enter the API key it expects, then discover again."
	case strings.Contains(lower, "http 404"):
		return "The endpoint has no model list at that address (" + message + "). Most OpenAI-compatible servers expect the base URL to end in /v1."
	case strings.Contains(lower, "http 5"):
		return "The endpoint failed while listing models (" + message + "). Check the gateway's own log, then try again."
	case strings.Contains(lower, "invalid base url"), strings.Contains(lower, "must be http"):
		return "The base URL is not usable (" + message + "). It must be a full http(s) URL, for example http://127.0.0.1:3425/v1."
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "The endpoint did not answer in time. Check that it is running and that the base URL is correct."
	}
	return "Could not discover models from " + baseURL + ": " + text + ". Check the base URL, that the service is running, and whether it needs an API key."
}

// testErrorText 把 models.test 的业务错误补成可操作的话。模型测试不会抛 RPC 错误，失败都在 text 里。
func testErrorText(baseURL, message string) string {
	lower := strings.ToLower(message)
	switch {
	case containsAny(lower, "401", "403", "unauthorized", "invalid api key", "api key", "authentication", "auth"):
		return "The test was rejected: " + message + ". Set the API key for this provider, then test again."
	case containsAny(lower, "404", "not found", "unknown model"):
		return "The provider does not offer this model: " + message + ". Discover the models again and pick one from the list."
	case containsAny(lower, "econnrefused", "connect", "fetch failed", "network", "dns", "timeout", "timed out"):
		return "Could not reach " + baseURL + ": " + message + ". Check that the local gateway is running and the base URL is correct."
	}
	return "The test failed: " + message
}

func containsAny(s string, parts ...string) bool {
	for _, p := range parts {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

// slug 把显示名变成 provider id 的后半段：小写字母、数字和单个连字符。
func slug(name string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

// uniqueProviderID 生成一个还没被使用的 custom-<base> id。
func uniqueProviderID(a *app, base string) string {
	if base == "" {
		base = "provider"
	}
	id := "custom-" + base
	used := map[string]bool{}
	if a.st.view != nil {
		for _, p := range a.st.view.Providers {
			used[p.ID] = true
		}
	}
	if !used[id] {
		return id
	}
	for n := 2; ; n++ {
		candidate := "custom-" + base + "-" + strconv.Itoa(n)
		if !used[candidate] {
			return candidate
		}
	}
}
