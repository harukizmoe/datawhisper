package app

// 设置页的界面：模型提供方卡片与编辑器、默认模型、用量、服务状态，以及「通用」分区。状态与动作在 settings.go。

import (
	"sort"
	"strconv"
	"strings"

	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// settings 构建设置页：模型/用量（服务提供）与通用（本地的外观、语言与文件）。两个分区用 Tabs 切换，
// 「通用」不依赖服务，服务没起来时也能改外观与语言。
func (a *app) settings(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, a.tr("settings.title")).Bold().FontSize(20)
			ui.Spacer(c)
			if a.client != nil && ui.Button(c, a.tr("settings.refresh")).Clicked() {
				a.loadSettings()
			}
			if a.st.loading && a.st.loaded {
				ui.Spinner(c)
			}
		})
		ui.Row(c).Padding(8, 24).Children(func() {
			ui.Tabs(c, &a.st.tab, a.tr("settings.models"), a.tr("settings.general"), a.tr("settings.appearance"), a.tr("settings.integrations"))
		})
		switch a.st.tab {
		case settingsTabGeneral:
			a.generalSettings(c, t)
			return
		case settingsTabAppearance:
			a.appearanceSettings(c, t)
			return
		case settingsTabIntegrations:
			a.integrationSettings(c, t)
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
			})
		})
		a.confirmModal(c, t)
	})
}

// generalSettings 是外观、语言与文件：全部在本地，不需要服务就绪。改动立即生效，并写进 <dataDir>/ui.json。
func (a *app) generalSettings(c *ui.Context, t *ui.Theme) {
	a.showNotice(c)
	ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
		ui.Column(c).Padding(24, 32).Gap(22).MaxWidth(900).Children(func() {
			a.languageSection(c, t)
			a.filesSection(c, t)
			a.serviceSection(c, t)
			if a.prefsErr != "" {
				ui.Text(c, a.tr("settings.saveFailed", "error", a.prefsErr)).FontSize(a.fs(textCaption)).TextColor(themeColor(t, "danger"))
			}
		})
	})
}

// languageSection 是界面语言的三选一：跟随系统、English、简体中文。
func (a *app) languageSection(c *ui.Context, t *ui.Theme) {
	langs := []string{i18n.System, i18n.EN, i18n.ZH}
	labels := []string{a.tr("settings.system"), i18n.Label(i18n.EN), i18n.Label(i18n.ZH)}
	choice := 0
	for i, pref := range langs {
		if a.prefs.Language == pref {
			choice = i
		}
	}
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, a.tr("settings.language")).Bold().FontSize(a.fs(textSection))
		ui.Text(c, a.tr("settings.languageTip")).FontSize(a.fs(textCaption)).TextColor(themeColor(t, "muted"))
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
				ui.Text(c, shown).FontSize(a.fs(textCaption)).TextColor(themeColor(t, "muted")).Selectable().Grow(1).MinWidth(0).SingleLine()
				if ui.Button(c, openLabel).Disabled(path == "").Clicked() {
					open()
				}
			})
		})
	}
	ui.Column(c).Gap(10).Children(func() {
		ui.Text(c, a.tr("settings.files")).Bold().FontSize(a.fs(textSection))
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
		label := a.statusLabel()
		if a.service.State == supervisor.StateReady {
			ui.Text(c, a.tr("settings.process", "status", label, "pid", strconv.Itoa(a.service.PID)))
		} else {
			ui.Text(c, label)
		}
		if a.logPath != "" {
			ui.Text(c, a.tr("settings.log", "path", a.logPath)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
		}
	})
}

func (a *app) providersSection(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(10).Children(func() {
		ui.Text(c, a.tr("settings.providers")).Bold().FontSize(a.fs(textSection))
		if a.st.view == nil || len(a.st.view.Providers) == 0 {
			ui.Text(c, a.tr("settings.noProvider")).TextColor(t.TextMuted)
			return
		}
		for i := range a.st.view.Providers {
			a.providerCard(c, t, a.st.view.Providers[i])
		}
	})
}

func (a *app) providerCard(c *ui.Context, t *ui.Theme, p service.ModelProvider) {
	tok := a.tokens().Tok
	ui.Column(c).Gap(8).Padding(14).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, p.Name).Bold()
			ui.Badge(c, p.Kind)
			if p.BaseURL != "" {
				a.buffer(ui.Text(c, p.BaseURL)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0).Tooltip(p.BaseURL)
			} else {
				ui.Spacer(c)
			}
			ui.Text(c, keyStatus(p)).FontSize(a.fs(textCaption)).TextColor(keyStatusColor(t, p)).Shrink(0)
			enabled := p.Enabled
			if ui.Switch(c, &enabled).Label(a.tr("settings.enableProvider", "name", p.Name)).Changed() {
				a.setProviderEnabled(p, enabled)
			}
		})
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			count := len(p.Models)
			if p.Kind == "builtin" {
				count = a.availableCount(p.ID)
			}
			// 屏幕上只写「模型 N」，无障碍标签保留完整的说明（读屏软件读出提供方的名字）。
			label, chevron := a.tr("settings.showModels", "name", p.Name, "count", strconv.Itoa(count)), icons.ChevronRight
			if a.isExpanded(p.ID) {
				label, chevron = a.tr("settings.hideModels", "name", p.Name, "count", strconv.Itoa(count)), icons.ChevronDown
			}
			if ui.Button(c, "").Label(label).Children(func() {
				ui.Text(c, a.tr("settings.modelsCount", "count", strconv.Itoa(count))).SingleLine()
				ui.Icon(c, chevron)
			}).Clicked() {
				a.setExpanded(p.ID, !a.isExpanded(p.ID))
			}
			if p.AuthSource != nil && *p.AuthSource != "" {
				ui.Text(c, a.tr("settings.authSource", "source", *p.AuthSource)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().MinWidth(0)
			}
			ui.Spacer(c)
			// 次要操作收进「⋯」菜单：卡片上不再并排一串带提供方名字的长按钮。
			ui.Button(c, "").Label(a.tr("settings.providerActions", "name", p.Name)).Tooltip(a.tr("settings.moreActions")).Children(func() {
				ui.Icon(c, icons.More)
			}).PopoverMenuButton(func(m *ui.Menu) {
				if m.Item(a.tr("settings.setKey")).Chosen() {
					a.st.keyProvider = p.ID
					a.st.keyInput, a.st.keyErr = "", ""
					a.st.notice = ""
				}
				if p.HasStoredKey && m.Item(a.tr("settings.clearKey")).Chosen() {
					a.st.confirmKind, a.st.confirmProvider, a.st.modalOpen = "clear-key", p.ID, true
				}
				if p.Kind == "custom" && m.Item(a.tr("settings.editProvider")).Chosen() {
					a.startEditProvider(p)
				}
				m.Separator()
				if m.Item(a.tr("settings.removeProvider")).Chosen() {
					a.st.confirmKind, a.st.confirmProvider, a.st.modalOpen = "remove", p.ID, true
				}
			})
		})
		if a.isExpanded(p.ID) {
			a.providerModels(c, t, p)
		}
		if a.st.keyProvider == p.ID {
			a.keyEditor(c, t, p)
		}
	})
}

func (a *app) providerModels(c *ui.Context, t *ui.Theme, p service.ModelProvider) {
	var rows []settingsModelRow
	if p.Kind == "builtin" {
		rows = availableModelRows(a.st.available, p.ID)
		if len(rows) == 0 {
			ui.Text(c, "Enable this provider and store its API key to list the models from the built-in catalog.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
	} else {
		rows = providerModelRows(p.Models)
		if len(rows) == 0 {
			ui.Text(c, "No models yet: edit the provider and discover them from the endpoint.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
	}
	a.modelTable(c, t, rows, "Models for "+p.Name)
}

func providerModelRows(models []service.ProviderModel) []settingsModelRow {
	rows := make([]settingsModelRow, 0, len(models))
	for _, m := range models {
		rows = append(rows, settingsModelRow{
			ID: m.ID, Name: m.Name, ContextWindow: m.ContextWindow, MaxTokens: m.MaxTokens,
			Reasoning: m.Reasoning, Vision: m.Vision,
		})
	}
	return rows
}

func availableModelRows(models []service.AvailableModel, provider string) []settingsModelRow {
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

func (a *app) keyEditor(c *ui.Context, t *ui.Theme, p service.ModelProvider) {
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
	ui.Text(c, "The key is sent to the service and never shown again.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	if a.st.keyErr != "" {
		ui.Text(c, a.st.keyErr).TextColor(t.Danger).FontSize(a.fs(textCaption))
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
		ui.Text(c, title).Bold().FontSize(a.fs(textSection))
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
		ui.Text(c, "The API key is only used to list and test models; saving stores it in the service and it never comes back.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if a.st.discoverErr != "" {
			ui.Text(c, a.st.discoverErr).TextColor(t.Danger).FontSize(a.fs(textCaption))
		}
		if a.st.formErr != "" {
			ui.Text(c, a.st.formErr).TextColor(t.Danger).FontSize(a.fs(textCaption))
		}
		if anyInferred(d) {
			ui.Text(c, "Some models did not report their context length: the conservative defaults (32k context / 4k output) were filled in. Check them before saving.").
				TextColor(t.Warning).FontSize(a.fs(textCaption))
		}
		if len(d.models) > 0 {
			ui.Text(c, a.tr("settings.models")).Bold().Margin(4, 0, 0, 0)
			a.editorModelsTable(c, t, d)
		}
		if a.st.testMsg != "" {
			ui.Text(c, a.st.testMsg).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
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
		ui.Text(c, "Default model").Bold().FontSize(a.fs(textSection))
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
					a.saveDefaultModel() // 选中即保存，不再另点「保存」
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
					a.saveDefaultModel()
				}
			})
			if a.st.defBusy {
				ui.Spinner(c)
			}
		})
		if m := a.selectedDefaultModel(); m != nil && len(m.ThinkingLevels) == 0 {
			ui.Text(c, "This model does not offer thinking levels; the service uses its own default.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		if a.st.defErr != "" {
			ui.Text(c, a.st.defErr).TextColor(t.Danger).FontSize(a.fs(textCaption))
		}
	})
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
		ui.Text(c, "Usage").Bold().FontSize(a.fs(textSection))
		if a.st.usageErr != "" {
			ui.Text(c, "Could not load the usage: "+a.st.usageErr).TextColor(t.Danger)
			return
		}
		if a.st.usage == nil {
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
			return
		}
		total := usageTotals(a.st.usage)
		if total.TotalTokens == 0 && total.Input == 0 && total.Output == 0 {
			ui.Text(c, a.tr("settings.noUsage")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		ui.Row(c).Gap(24).Wrap().Children(func() {
			a.usageMetric(c, t, "Input tokens", formatCount(total.Input))
			a.usageMetric(c, t, "Output tokens", formatCount(total.Output))
			a.usageMetric(c, t, "Cache hits", formatCount(total.CacheRead))
			a.usageMetric(c, t, "Cache writes", formatCount(total.CacheWrite))
			a.usageMetric(c, t, "Total tokens", formatCount(total.TotalTokens))
			a.usageMetric(c, t, "Cost (USD)", formatCost(total.Cost.Total))
		})
		keys := make([]string, 0, len(a.st.usage.Models))
		for key := range a.st.usage.Models {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			u := a.st.usage.Models[key]
			ui.Textf(c, "%s · %s input · %s output · %s cache hits", key, formatCount(u.Input), formatCount(u.Output), formatCount(u.CacheRead)).
				FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
	})
}

func (a *app) usageMetric(c *ui.Context, t *ui.Theme, label, value string) {
	ui.Column(c).Gap(2).Children(func() {
		ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
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
		ui.Text(c, "Agent service").Bold().FontSize(a.fs(textSection))
		label := a.statusLabel()
		if a.service.State == supervisor.StateReady {
			ui.Textf(c, "%s: process %d", label, a.service.PID)
		} else {
			ui.Text(c, label)
		}
		if a.st.view != nil && a.st.view.CredentialBackend != "" {
			ui.Text(c, "Credential backend: "+a.st.view.CredentialBackend).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		if a.logPath != "" {
			ui.Text(c, "Log: "+a.logPath).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
		}
	})
}

func keyStatusColor(t *ui.Theme, p service.ModelProvider) ui.Color {
	switch {
	case p.HasStoredKey:
		return t.Success
	case !p.KeyRequired:
		return t.TextMuted
	default:
		return t.Warning
	}
}
