package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/api"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// settingsState 是设置页的数据与编辑状态。只有 UI 线程会改它：构建视图时，以及在 post 上排队的函数里。
type settingsState struct {
	gen     int // 丢弃旧加载的结果
	loading bool
	loaded  bool
	err     string

	view         *api.ModelsView
	available    []api.AvailableModel
	availableErr string
	usage        *api.UsageSummary
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
	models      []api.ProviderModel
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
func (a *app) syncDefaultForm(view *api.ModelsView) {
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

// settings 构建设置页：模型/用量（服务提供）与通用（本地的外观、语言与文件）。两个分区用 Tabs 切换，
// 「通用」不依赖服务，服务没起来时也能改外观与语言。
func (a *app) settings(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, a.tr("settings.title")).Bold().FontSize(20)
			label, color := a.statusLabel(t)
			ui.Text(c, "●").TextColor(color)
			ui.Text(c, label).TextColor(t.TextMuted)
			ui.Spacer(c)
			if a.client != nil && ui.Button(c, a.tr("settings.refresh")).Clicked() {
				a.loadSettings()
			}
			if a.st.loading && a.st.loaded {
				ui.Spinner(c)
			}
		})
		ui.Row(c).Padding(8, 24).Children(func() {
			ui.Tabs(c, &a.st.tab, a.tr("settings.models"), a.tr("settings.general"))
		})
		if a.st.tab == settingsTabGeneral {
			a.generalSettings(c, t)
			return
		}
		if a.client == nil {
			a.settingsUnavailable(c, t)
			return
		}
		if a.st.loading && !a.st.loaded {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(24, 32).Children(func() {
				ui.Spinner(c)
				ui.Text(c, a.tr("settings.loading")).TextColor(t.TextMuted)
			})
			return
		}
		a.showNotice(c)
		ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
			ui.Column(c).Padding(24, 32).Gap(18).MaxWidth(900).Children(func() {
				if a.st.err != "" {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(c, a.tr("settings.loadFailed", "error", a.st.err)).TextColor(t.Danger).Grow(1).MinWidth(0)
						if ui.Button(c, a.tr("settings.tryAgain")).Clicked() {
							a.loadSettings()
						}
					})
				}
				a.providersSection(c, t)
				a.providerEditor(c, t)
				a.defaultModelSection(c, t)
				a.usageSection(c, t)
				a.serviceSection(c, t)
			})
		})
		a.confirmModal(c, t)
	})
}

// settingsTabGeneral 是设置页「通用」分区的索引。
const settingsTabGeneral = 1

// generalSettings 是外观、语言与文件：全部在本地，不需要服务就绪。改动立即生效，并写进 <dataDir>/ui.json。
func (a *app) generalSettings(c *ui.Context, t *ui.Theme) {
	a.showNotice(c)
	ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
		ui.Column(c).Padding(24, 32).Gap(22).MaxWidth(900).Children(func() {
			a.appearanceSection(c, t)
			a.languageSection(c, t)
			a.filesSection(c, t)
			if a.prefsErr != "" {
				ui.Text(c, a.tr("settings.saveFailed", "error", a.prefsErr)).FontSize(12).TextColor(themeColor(t, "danger"))
			}
		})
	})
}

// appearanceSection 是外观的三选一：跟随系统、浅色、深色。
func (a *app) appearanceSection(c *ui.Context, t *ui.Theme) {
	themes := []string{themeSystem, themeLight, themeDark}
	labels := []string{a.tr("settings.system"), a.tr("settings.light"), a.tr("settings.dark")}
	choice := 0
	for i, pref := range themes {
		if a.prefs.Theme == pref {
			choice = i
		}
	}
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, a.tr("settings.appearance")).Bold().FontSize(16)
		ui.Text(c, a.tr("settings.themeTip")).FontSize(12).TextColor(themeColor(t, "muted"))
		if ui.Segmented(c, &choice, labels...).MaxWidth(360).Label(a.tr("settings.appearance")).Changed() {
			a.setTheme(themes[choice])
		}
	})
}

// languageSection 是界面语言的三选一：跟随系统、English、简体中文。
func (a *app) languageSection(c *ui.Context, t *ui.Theme) {
	langs := []string{langSystem, langEN, langZH}
	labels := []string{a.tr("settings.system"), languageLabel(langEN), languageLabel(langZH)}
	choice := 0
	for i, pref := range langs {
		if a.prefs.Language == pref {
			choice = i
		}
	}
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, a.tr("settings.language")).Bold().FontSize(16)
		ui.Text(c, a.tr("settings.languageTip")).FontSize(12).TextColor(themeColor(t, "muted"))
		if ui.Segmented(c, &choice, labels...).MaxWidth(360).Label(a.tr("settings.language")).Changed() {
			a.setLanguage(langs[choice])
		}
	})
}

// filesSection 显示数据目录与服务日志的位置，并给出打开它们的按钮。
func (a *app) filesSection(c *ui.Context, t *ui.Theme) {
	row := func(label, path, openLabel string, open func()) {
		ui.Column(c).Gap(6).Children(func() {
			ui.Text(c, label).Bold()
			ui.Row(c).Gap(8).AlignItems(ui.Center).MaxWidth(640).Children(func() {
				shown := path
				if shown == "" {
					shown = a.tr("settings.notSet")
				}
				ui.Text(c, shown).FontSize(12).TextColor(themeColor(t, "muted")).Selectable().Grow(1).MinWidth(0).SingleLine()
				if ui.Button(c, openLabel).Disabled(path == "").Clicked() {
					open()
				}
			})
		})
	}
	ui.Column(c).Gap(10).Children(func() {
		ui.Text(c, a.tr("settings.files")).Bold().FontSize(16)
		row(a.tr("settings.dataDir"), a.dataDir, a.tr("settings.openFolder"), a.openDataDir)
		row(a.tr("settings.serviceLog"), a.logPath, a.tr("settings.openLog"), a.openServiceLog)
	})
}

// showNotice 把最近一次操作的结果放进 MyGo 的 toast；每帧最多一次，然后清空状态。
func (a *app) showNotice(c *ui.Context) {
	if a.st.notice == "" {
		return
	}
	if a.st.noticeErr {
		c.AddToast(ui.Toast{Title: a.st.notice, Type: "error"})
	} else {
		c.Toast(a.st.notice)
	}
	a.st.notice, a.st.noticeErr = "", false
}

func (a *app) settingsUnavailable(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Padding(24, 32).Gap(8).Children(func() {
		ui.Text(c, a.tr("settings.unavailable")).TextColor(t.TextMuted)
		label, _ := a.statusLabel(t)
		if a.service.State == supervisor.StateReady {
			ui.Text(c, a.tr("settings.process", "status", label, "pid", strconv.Itoa(a.service.PID)))
		} else {
			ui.Text(c, label)
		}
		if a.logPath != "" {
			ui.Text(c, a.tr("settings.log", "path", a.logPath)).FontSize(12).TextColor(t.TextMuted).Selectable()
		}
	})
}

func (a *app) providersSection(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(10).Children(func() {
		ui.Text(c, a.tr("settings.providers")).Bold().FontSize(16)
		if a.st.view == nil || len(a.st.view.Providers) == 0 {
			ui.Text(c, a.tr("settings.noProvider")).TextColor(t.TextMuted)
			return
		}
		for i := range a.st.view.Providers {
			a.providerCard(c, t, a.st.view.Providers[i])
		}
	})
}

func (a *app) providerCard(c *ui.Context, t *ui.Theme, p api.ModelProvider) {
	ui.Column(c).Gap(8).Padding(14).Radius(10).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, p.Name).Bold()
			ui.Badge(c, p.Kind)
			if p.BaseURL != "" {
				ui.Text(c, p.BaseURL).FontSize(12).TextColor(t.TextMuted).Grow(1).MinWidth(0)
			} else {
				ui.Spacer(c)
			}
			ui.Text(c, keyStatus(p)).FontSize(12).TextColor(keyStatusColor(t, p))
			enabled := p.Enabled
			if ui.Switch(c, &enabled).Label("Enable provider " + p.Name).Changed() {
				a.setProviderEnabled(p, enabled)
			}
		})
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			count := len(p.Models)
			if p.Kind == "builtin" {
				count = a.availableCount(p.ID)
			}
			modelsLabel := fmt.Sprintf("Show models for %s (%d)", p.Name, count)
			if a.isExpanded(p.ID) {
				modelsLabel = fmt.Sprintf("Hide models for %s (%d)", p.Name, count)
			}
			if ui.Button(c, modelsLabel).Clicked() {
				a.setExpanded(p.ID, !a.isExpanded(p.ID))
			}
			if ui.Button(c, "Set key for "+p.Name).Clicked() {
				a.st.keyProvider = p.ID
				a.st.keyInput, a.st.keyErr = "", ""
				a.st.notice = ""
			}
			if p.HasStoredKey {
				if ui.Button(c, "Clear key for "+p.Name).Clicked() {
					a.st.confirmKind, a.st.confirmProvider, a.st.modalOpen = "clear-key", p.ID, true
				}
			}
			if p.Kind == "custom" {
				if ui.Button(c, "Edit "+p.Name).Clicked() {
					a.startEditProvider(p)
				}
			}
			ui.Spacer(c)
			if ui.Button(c, "Remove "+p.Name).Clicked() {
				a.st.confirmKind, a.st.confirmProvider, a.st.modalOpen = "remove", p.ID, true
			}
		})
		if p.AuthSource != nil && *p.AuthSource != "" {
			ui.Text(c, "Authentication: "+*p.AuthSource).FontSize(12).TextColor(t.TextMuted)
		}
		if a.isExpanded(p.ID) {
			a.providerModels(c, t, p)
		}
		if a.st.keyProvider == p.ID {
			a.keyEditor(c, t, p)
		}
	})
}

func (a *app) providerModels(c *ui.Context, t *ui.Theme, p api.ModelProvider) {
	var rows []settingsModelRow
	if p.Kind == "builtin" {
		rows = availableModelRows(a.st.available, p.ID)
		if len(rows) == 0 {
			ui.Text(c, "Enable this provider and store its API key to list the models from the built-in catalog.").FontSize(12).TextColor(t.TextMuted)
			return
		}
	} else {
		rows = providerModelRows(p.Models)
		if len(rows) == 0 {
			ui.Text(c, "No models yet: edit the provider and discover them from the endpoint.").FontSize(12).TextColor(t.TextMuted)
			return
		}
	}
	a.modelTable(c, t, rows, "Models for "+p.Name)
}

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

func providerModelRows(models []api.ProviderModel) []settingsModelRow {
	rows := make([]settingsModelRow, 0, len(models))
	for _, m := range models {
		rows = append(rows, settingsModelRow{
			ID: m.ID, Name: m.Name, ContextWindow: m.ContextWindow, MaxTokens: m.MaxTokens,
			Reasoning: m.Reasoning, Vision: m.Vision,
		})
	}
	return rows
}

func availableModelRows(models []api.AvailableModel, provider string) []settingsModelRow {
	var rows []settingsModelRow
	for _, m := range models {
		if m.Provider != provider {
			continue
		}
		rows = append(rows, settingsModelRow{
			ID: m.ID, Name: m.Name, ContextWindow: m.ContextWindow, MaxTokens: m.MaxTokens,
			Reasoning: m.Reasoning, Vision: m.Vision, Levels: m.ThinkingLevels,
		})
	}
	return rows
}

// modelTable 用 MyGo 的 Table 列出模型：上下文窗口、输出上限与能力各占一列。
func (a *app) modelTable(c *ui.Context, t *ui.Theme, rows []settingsModelRow, label string) {
	columns := []ui.TableColumn{
		{Title: "Model", ID: "model", MinWidth: 120},
		{Title: "Name", ID: "name", Width: 150},
		{Title: "Context", ID: "context", Width: 84, Align: ui.End},
		{Title: "Max output", ID: "max", Width: 100, Align: ui.End},
		{Title: "Capabilities", ID: "capabilities"},
	}
	ui.Table(c, nil, columns, len(rows), func(row, col int) {
		m := rows[row]
		switch col {
		case 0:
			ui.Text(c, m.ID).SingleLine()
		case 1:
			ui.Text(c, modelName(m.Name, m.ID)).SingleLine()
		case 2:
			ui.Text(c, formatCount(m.ContextWindow)).SingleLine()
		case 3:
			ui.Text(c, formatCount(m.MaxTokens)).SingleLine()
		case 4:
			ui.Text(c, capabilitiesText(m.Reasoning, m.Vision, m.Levels)).SingleLine()
		}
	}).Height(t.Space(8) * float32(len(rows)+1)).Label(label)
}

func modelName(name, id string) string {
	if name == "" || name == id {
		return "—"
	}
	return name
}

func capabilitiesText(reasoning, vision bool, levels []string) string {
	var parts []string
	if reasoning {
		parts = append(parts, "reasoning")
	}
	if vision {
		parts = append(parts, "vision")
	}
	if len(levels) > 0 {
		parts = append(parts, "thinking: "+strings.Join(levels, ", "))
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, " · ")
}

func (a *app) availableCount(providerID string) int {
	n := 0
	for _, m := range a.st.available {
		if m.Provider == providerID {
			n++
		}
	}
	return n
}

func (a *app) keyEditor(c *ui.Context, t *ui.Theme, p api.ModelProvider) {
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		input := ui.TextInput(c, &a.st.keyInput).Password().Label("API key for " + p.Name).
			Placeholder("Paste the API key").Width(340)
		if ui.PrimaryButton(c, "Save key").Clicked() || input.Submitted() {
			a.saveProviderKey(p)
		}
		if ui.Button(c, "Cancel key").Clicked() {
			a.st.keyProvider, a.st.keyInput, a.st.keyErr = "", "", ""
		}
		if a.st.keyBusy {
			ui.Spinner(c)
		}
	})
	ui.Text(c, "The key is sent to the service and never shown again.").FontSize(12).TextColor(t.TextMuted)
	if a.st.keyErr != "" {
		ui.Text(c, a.st.keyErr).TextColor(t.Danger).FontSize(12)
	}
}

func (a *app) providerEditor(c *ui.Context, t *ui.Theme) {
	if a.st.editing == nil {
		if ui.Button(c, a.tr("settings.addProvider")).Clicked() {
			a.startAddProvider()
		}
		return
	}
	d := a.st.editing
	title := "New provider"
	if d.existing {
		title = "Edit " + d.name
	}
	ui.Column(c).Gap(10).Padding(14).Radius(10).Background(t.Surface).BorderWidth(1).BorderColor(t.Accent.Alpha(0.5)).Children(func() {
		ui.Text(c, title).Bold().FontSize(16)
		if !d.existing && a.st.view != nil {
			labels := []string{"Custom endpoint"}
			for _, p := range a.st.view.Presets {
				labels = append(labels, presetLabel(p))
			}
			choice := a.st.presetChoice
			if choice == "" {
				choice = "Custom endpoint"
			}
			ui.Field(c, "Endpoint preset", func() {
				if ui.Select(c, &choice, labels).Label("Endpoint preset").Changed() {
					a.applyPreset(choice)
				}
			})
		}
		ui.Row(c).Gap(12).AlignItems(ui.Start).Children(func() {
			ui.Field(c, "Provider id", func() {
				if ui.TextInput(c, &d.id).Label("Provider id").Placeholder("custom-my-endpoint").Changed() {
					d.idTouched = true
				}
			}).Grow(1)
			ui.Field(c, "Display name", func() {
				if ui.TextInput(c, &d.name).Label("Provider name").Placeholder("My endpoint").Changed() && !d.existing && !d.idTouched {
					d.id = uniqueProviderID(a, slug(d.name))
				}
			}).Grow(1)
		})
		ui.Field(c, "Base URL", func() {
			ui.TextInput(c, &d.baseURL).Label("Base URL").Placeholder("http://127.0.0.1:3425/v1")
		})
		ui.Checkbox(c, &d.requiresKey, "Requires an API key")
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.TextInput(c, &d.key).Password().Label("API key").Placeholder("Paste the API key (optional for local models)").Grow(1)
			discover := ui.Button(c, "Discover models")
			if a.st.discovering {
				discover.Disabled(true)
				ui.Spinner(c)
			}
			if discover.Clicked() {
				a.discoverModels()
			}
		})
		ui.Text(c, "The API key is only used to list and test models; saving stores it in the service and it never comes back.").FontSize(12).TextColor(t.TextMuted)
		if a.st.discoverErr != "" {
			ui.Text(c, a.st.discoverErr).TextColor(t.Danger).FontSize(12)
		}
		if a.st.formErr != "" {
			ui.Text(c, a.st.formErr).TextColor(t.Danger).FontSize(12)
		}
		if anyInferred(d) {
			ui.Text(c, "Some models did not report their context length: the conservative defaults (32k context / 4k output) were filled in. Check them before saving.").
				TextColor(t.Warning).FontSize(12)
		}
		if len(d.models) > 0 {
			ui.Text(c, a.tr("settings.models")).Bold().Margin(4, 0, 0, 0)
			a.editorModelsTable(c, t, d)
		}
		if a.st.testMsg != "" {
			ui.Text(c, a.st.testMsg).FontSize(12).TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			save := ui.PrimaryButton(c, "Save provider")
			if a.st.saveBusy {
				save.Disabled(true)
				ui.Spinner(c)
			}
			if save.Clicked() {
				a.saveProvider()
			}
			if ui.Button(c, "Cancel provider").Clicked() {
				a.closeEditor()
			}
		})
	})
}

// editorModelsTable 是「发现模型」后的勾选表：勾选要启用的模型，并在保存前逐个测试。
func (a *app) editorModelsTable(c *ui.Context, t *ui.Theme, d *providerDraft) {
	columns := []ui.TableColumn{
		{Title: "Use", ID: "use", Width: 140, Fixed: true},
		{Title: "Model", ID: "model", MinWidth: 110},
		{Title: "Context", ID: "context", Width: 84, Align: ui.End},
		{Title: "Max output", ID: "max", Width: 100, Align: ui.End},
		{Title: "Capabilities", ID: "capabilities"},
		{Title: "Test", ID: "test", Width: 150, Fixed: true},
	}
	ui.Table(c, nil, columns, len(d.models), func(row, col int) {
		m := d.models[row]
		switch col {
		case 0:
			on := d.include[m.ID]
			if ui.Checkbox(c, &on, "Use "+m.ID).Changed() {
				d.include[m.ID] = on
			}
		case 1:
			ui.Text(c, m.ID).SingleLine()
		case 2:
			ui.Text(c, formatCount(m.ContextWindow)).SingleLine()
		case 3:
			ui.Text(c, formatCount(m.MaxTokens)).SingleLine()
		case 4:
			caps := capabilitiesText(m.Reasoning, m.Vision, nil)
			if d.inferred[m.ID] {
				caps += " · context inferred"
			}
			ui.Text(c, caps).SingleLine()
		case 5:
			test := ui.Button(c, "Test "+m.ID)
			if a.st.testBusy {
				test.Disabled(true)
			}
			if test.Clicked() {
				a.testDraftModel(m.ID)
			}
		}
	}).Height(t.Space(8) * float32(len(d.models)+1)).Label("Discovered models")
}

func (a *app) defaultModelSection(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, "Default model").Bold().FontSize(16)
		if a.st.availableErr != "" {
			ui.Text(c, "Could not load the available models: "+a.st.availableErr).TextColor(t.Danger)
			return
		}
		if len(a.st.available) == 0 {
			ui.Text(c, "No model is available: enable a provider and store its key first.").TextColor(t.TextMuted)
			return
		}
		options := []string{settingsPageLabel}
		for _, m := range a.st.available {
			options = append(options, modelLabel(m))
		}
		choice := a.st.defChoice
		if choice == "" {
			choice = settingsPageLabel
		}
		ui.Row(c).Gap(12).AlignItems(ui.End).Children(func() {
			ui.Field(c, "Model", func() {
				if ui.Select(c, &choice, options).Label("Choose default model").Changed() {
					a.st.defChoice = ""
					if choice != settingsPageLabel {
						a.st.defChoice = choice
					}
					a.defThinkingForChoice()
				}
			}).Grow(1)
			ui.Field(c, "Thinking level", func() {
				m := a.selectedDefaultModel()
				var levels []string
				if m != nil {
					levels = m.ThinkingLevels
				}
				think := a.st.defThinking
				if think == "" {
					think = defaultThinkingLabel
				}
				opts := append([]string{defaultThinkingLabel}, levels...)
				sel := ui.Select(c, &think, opts).Label("Choose thinking level")
				if len(levels) == 0 {
					sel.Disabled(true)
				}
				if sel.Changed() {
					if think == defaultThinkingLabel {
						a.st.defThinking = ""
					} else {
						a.st.defThinking = think
					}
				}
			})
			save := ui.PrimaryButton(c, "Save default model")
			if a.st.defBusy {
				save.Disabled(true)
			}
			if save.Clicked() {
				a.saveDefaultModel()
			}
		})
		if m := a.selectedDefaultModel(); m != nil && len(m.ThinkingLevels) == 0 {
			ui.Text(c, "This model does not offer thinking levels; the service uses its own default.").FontSize(12).TextColor(t.TextMuted)
		}
		if a.st.defErr != "" {
			ui.Text(c, a.st.defErr).TextColor(t.Danger).FontSize(12)
		}
	})
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

func (a *app) selectedDefaultModel() *api.AvailableModel {
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

func (a *app) providerByID(id string) (api.ModelProvider, bool) {
	if a.st.view == nil {
		return api.ModelProvider{}, false
	}
	for _, p := range a.st.view.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return api.ModelProvider{}, false
}

// confirmModal 用 MyGo 的 Modal 再次确认删除提供商或清除密钥。
func (a *app) confirmModal(c *ui.Context, t *ui.Theme) {
	if !a.st.modalOpen {
		return
	}
	p, ok := a.providerByID(a.st.confirmProvider)
	if !ok {
		a.st.modalOpen = false
		return
	}
	ui.Modal(c, &a.st.modalOpen, func() {
		switch a.st.confirmKind {
		case "remove":
			ui.Text(c, "Remove provider?").Bold()
			ui.Textf(c, "%s and its stored API key will be removed. Conversations that use its models will need another model.", p.Name).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					a.st.modalOpen = false
				}
				if ui.Button(c, "Confirm remove provider").Clicked() {
					a.st.modalOpen = false
					a.removeProvider(p)
				}
			})
		case "clear-key":
			ui.Text(c, "Clear the API key?").Bold()
			ui.Textf(c, "The API key stored for %s will be deleted; the provider and its models stay.", p.Name).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					a.st.modalOpen = false
				}
				if ui.PrimaryButton(c, "Confirm clear key").Clicked() {
					a.st.modalOpen = false
					a.clearProviderKey(p)
				}
			})
		default:
			a.st.modalOpen = false
		}
	})
}

func (a *app) usageSection(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, "Usage").Bold().FontSize(16)
		if a.st.usageErr != "" {
			ui.Text(c, "Could not load the usage: "+a.st.usageErr).TextColor(t.Danger)
			return
		}
		if a.st.usage == nil {
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
			return
		}
		total := usageTotals(a.st.usage)
		ui.Row(c).Gap(24).Children(func() {
			usageMetric(c, t, "Input tokens", formatCount(total.Input))
			usageMetric(c, t, "Output tokens", formatCount(total.Output))
			usageMetric(c, t, "Cache hits", formatCount(total.CacheRead))
			usageMetric(c, t, "Cache writes", formatCount(total.CacheWrite))
			usageMetric(c, t, "Total tokens", formatCount(total.TotalTokens))
			usageMetric(c, t, "Cost (USD)", formatCost(total.Cost.Total))
		})
		keys := make([]string, 0, len(a.st.usage.Models))
		for key := range a.st.usage.Models {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			u := a.st.usage.Models[key]
			ui.Textf(c, "%s · %s input · %s output · %s cache hits", key, formatCount(u.Input), formatCount(u.Output), formatCount(u.CacheRead)).
				FontSize(12).TextColor(t.TextMuted)
		}
	})
}

func usageMetric(c *ui.Context, t *ui.Theme, label, value string) {
	ui.Column(c).Gap(2).Children(func() {
		ui.Text(c, label).FontSize(12).TextColor(t.TextMuted)
		ui.Text(c, value).Bold()
	})
}

// formatCost 以美元显示费用，最多四位小数，去掉多余的零。
func formatCost(v float64) string {
	text := strings.TrimRight(strings.TrimRight(strconv.FormatFloat(v, 'f', 4, 64), "0"), ".")
	if text == "" {
		text = "0"
	}
	return "$" + text
}

func (a *app) serviceSection(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(6).Children(func() {
		ui.Text(c, "Agent service").Bold().FontSize(16)
		label, _ := a.statusLabel(t)
		if a.service.State == supervisor.StateReady {
			ui.Textf(c, "%s: process %d", label, a.service.PID)
		} else {
			ui.Text(c, label)
		}
		if a.st.view != nil && a.st.view.CredentialBackend != "" {
			ui.Text(c, "Credential backend: "+a.st.view.CredentialBackend).FontSize(12).TextColor(t.TextMuted)
		}
		if a.logPath != "" {
			ui.Text(c, "Log: "+a.logPath).FontSize(12).TextColor(t.TextMuted).Selectable()
		}
	})
}

// --- 操作 ---

func (a *app) setProviderEnabled(p api.ModelProvider, on bool) {
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

func (a *app) saveProviderKey(p api.ModelProvider) {
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

func (a *app) clearProviderKey(p api.ModelProvider) {
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

func (a *app) removeProvider(p api.ModelProvider) {
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
	var ref *api.ModelRef
	if a.st.defChoice != "" {
		m := a.selectedDefaultModel()
		if m == nil {
			a.st.defErr = "Choose a model that is currently available."
			return
		}
		ref = &api.ModelRef{Provider: m.Provider, ModelID: m.ID}
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

func (a *app) startEditProvider(p api.ModelProvider) {
	d := &providerDraft{
		existing:    true,
		id:          p.ID,
		name:        p.Name,
		baseURL:     p.BaseURL,
		requiresKey: p.RequiresKey || p.KeyRequired,
		idTouched:   true,
		models:      append([]api.ProviderModel(nil), p.Models...),
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
			d.models = make([]api.ProviderModel, 0, len(models))
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
		result, err := client.TestModel(ctx, api.ModelRef{Provider: d.id, ModelID: modelID}, &settings, d.key)
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
	models := make([]api.ProviderModel, 0, len(d.models))
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

func providerSettings(p api.ModelProvider) api.ProviderSettings {
	return api.ProviderSettings{
		Kind:        p.Kind,
		ID:          p.ID,
		Name:        p.Name,
		BaseURL:     p.BaseURL,
		RequiresKey: p.RequiresKey,
		Enabled:     p.Enabled,
		Models:      append([]api.ProviderModel(nil), p.Models...),
	}
}

func draftSettings(d *providerDraft) api.ProviderSettings {
	return api.ProviderSettings{
		Kind:        "custom",
		ID:          strings.TrimSpace(d.id),
		Name:        strings.TrimSpace(d.name),
		BaseURL:     strings.TrimSpace(d.baseURL),
		RequiresKey: d.requiresKey,
		Enabled:     true,
		Models:      append([]api.ProviderModel(nil), d.models...),
	}
}

func keyStatus(p api.ModelProvider) string {
	switch {
	case p.HasStoredKey:
		return "API key stored"
	case !p.KeyRequired:
		return "No key needed"
	default:
		return "No API key"
	}
}

func keyStatusColor(t *ui.Theme, p api.ModelProvider) ui.Color {
	switch {
	case p.HasStoredKey:
		return t.Success
	case !p.KeyRequired:
		return t.TextMuted
	default:
		return t.Warning
	}
}

func presetLabel(p api.ProviderPreset) string {
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

func modelLabel(m api.AvailableModel) string { return m.Provider + "/" + m.ID }

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
func usageTotals(u *api.UsageSummary) api.Usage {
	var total api.Usage
	for _, usage := range u.Models {
		addUsage(&total, usage)
	}
	for _, usage := range u.Tools {
		addUsage(&total, usage)
	}
	return total
}

func addUsage(total *api.Usage, u api.Usage) {
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
	var e *api.Error
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
	if errors.Is(err, api.ErrClosed) {
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
	var e *api.Error
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
