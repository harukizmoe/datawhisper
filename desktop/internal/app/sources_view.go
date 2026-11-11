package app

// 数据面板的界面：数据源、工作区、产物三个标签页，预览表格、远程连接表单与编辑弹窗。状态与动作在 sources.go。

import (
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// sourcesPanel 构建右侧的数据面板。
func (a *app) sourcesPanel(c *ui.Context) {
	t := c.Theme()
	panel := ui.Column(c).Grow(1).MinWidth(0).Background(t.Background)
	if a.islands() {
		panel = a.island(panel).Margin(0, 0, 0, islandGap/2)
	} else {
		panel = panel.BorderWidth(0, 0, 0, 1).BorderColor(t.Border)
	}
	panel.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(10, 16).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, a.tr("data.title")).Bold().FontSize(a.fs(textSection))
			if a.src.conv != 0 {
				ui.Text(c, a.tr("data.chat", "id", strconv.Itoa(a.src.conv))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			}
			ui.Spacer(c)
			if a.client != nil && ui.Button(c, a.tr("data.refresh")).Tooltip(a.tr("data.refreshTip")).Clicked() {
				a.loadSources()
			}
			if ui.Button(c, a.tr("data.hide")).Tooltip(a.tr("data.hideTip")).Clicked() {
				a.src.open = false
			}
		})
		if a.client == nil {
			ui.Text(c, a.tr("data.unavailable")).TextColor(t.TextMuted).Padding(16)
			return
		}
		if a.src.conv == 0 {
			ui.Text(c, a.tr("data.noChat")).TextColor(t.TextMuted).Padding(16)
			return
		}
		a.showSourceNotice(c)
		if a.src.loading && !a.src.loaded {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(16).Children(func() {
				ui.Spinner(c)
				ui.Text(c, a.tr("data.loading")).TextColor(t.TextMuted)
			})
			return
		}
		ui.Tabs(c, &a.src.tab, a.tr("data.tabSources"), a.tr("data.tabWorkspace"), a.tr("data.tabArtifacts"), a.tr("data.tabRuns")).Label(a.tr("data.tabsLabel")).Changed()
		ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
			ui.Column(c).Padding(14, 16).Gap(14).Children(func() {
				if a.src.err != "" {
					ui.Text(c, a.src.err).TextColor(t.Danger)
				}
				switch a.src.tab {
				case sourcesTabWorkspace:
					a.workspaceTab(c, t)
				case sourcesTabArtifacts:
					a.artifactsTab(c, t)
				case sourcesTabRuns:
					a.runsTab(c, t)
				default:
					a.sourcesTab(c, t)
				}
			})
		})
	})
	a.sourceModals(c, t)
}

// showSourceNotice 把最近一次操作的结果放进 toast；每帧最多一次，然后清空状态。
func (a *app) showSourceNotice(c *ui.Context) {
	if a.src.notice == "" {
		return
	}
	if a.src.noticeErr {
		c.AddToast(ui.Toast{Title: a.src.notice, Type: "error"})
	} else {
		c.Toast(a.src.notice)
	}
	a.src.notice, a.src.noticeErr = "", false
}

// sourcesTab 是「数据源」页签：导入、连接、列表、预览。
func (a *app) sourcesTab(c *ui.Context, t *ui.Theme) {
	limit := a.tr("data.limitUnknown")
	if a.src.maxBytes > 0 {
		limit = a.tr("data.limit", "size", formatBytes(a.src.maxBytes))
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		button := ui.Button(c, a.tr("data.import")).Tooltip(a.tr("data.importTip"))
		if a.client == nil || a.src.uploading {
			button.Disabled(true)
		}
		if button.Clicked() {
			a.pickFile()
		}
		ui.PopoverMenuButton(c, a.tr("data.connect"), func(m *ui.Menu) {
			for i := range remoteKinds {
				i := i
				if m.Item(a.kindLabel(remoteKinds[i])).Chosen() {
					a.startRemote(i)
				}
			}
		}).Tooltip(a.tr("data.connectTip"))
		ui.Spacer(c)
		if len(a.src.sources) > 0 {
			if ui.Button(c, a.tr("data.removeAll")).Tooltip(a.tr("data.removeAllTip")).Clicked() {
				a.src.confirmKind, a.src.confirmID, a.src.confirmName = confirmSourceAll, "", ""
				a.src.confirmOpen = true
			}
		}
	})
	ui.Text(c, limit).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	if a.src.uploading {
		ui.Column(c).Gap(4).Children(func() {
			ui.Text(c, a.tr("data.copying", "name", a.src.uploadName)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Progress(c, a.src.uploadProgress).Label(a.tr("data.importProgress"))
		})
	}
	if a.src.uploadErr != "" {
		ui.Text(c, a.src.uploadErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
	}
	if len(a.src.sources) == 0 {
		ui.Text(c, a.tr("data.empty")).TextColor(t.TextMuted)
	}
	for _, src := range a.src.sources {
		a.sourceCard(c, t, src)
	}
	if a.src.remoteOpen {
		a.remoteForm(c, t)
	}
	if a.src.previewID != "" {
		a.previewPanel(c, t)
	}
}

// sourceCard 是列表里的一行：名称、类型、表数、分析开关与操作。
func (a *app) sourceCard(c *ui.Context, t *ui.Theme, src service.Source) {
	ui.Column(c).Gap(6).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, src.Name).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(src.Name)
			ui.Badge(c, src.Kind)
			// 连接配置是全应用共享的：别的会话里也能看到它，默认不启用。
			if src.ConfigID != "" {
				ui.Badge(c, a.tr("data.shared")).Tooltip(a.tr("data.sharedTip"))
			}
		})
		state := a.tr("data.stateClosed")
		if src.Open {
			state = a.tr("data.stateOpen")
		}
		// 远程 SQL 来源没选表时 agent 什么都看不到：这里要明说，并给一个直接能点的入口，
		// 不能只写「0 张表」让人猜。
		needTables := src.Kind == "sql" && len(src.Tables) == 0
		if needTables {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, a.tr("data.noTablesChosen")).FontSize(a.fs(textCaption)).TextColor(t.Warning).Grow(1).MinWidth(0)
				if ui.PrimaryButton(c, a.tr("data.chooseTables")).Tooltip(a.tr("data.chooseTablesTip")).Clicked() {
					a.openSourceEditor(src, true)
				}
			})
		} else {
			ui.Text(c, a.tr("data.tables", "count", strconv.Itoa(len(src.Tables)), "state", state)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			active := src.Active
			ui.Switch(c, &active).Label(a.tr("data.useInAnalysis", "name", src.Name)).Changed()
			if active != src.Active {
				a.setSourceActive(src, active)
			}
			ui.Text(c, a.tr("data.inAnalysis")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		})
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			if ui.Button(c, a.tr("data.preview")).Tooltip(a.tr("data.previewTip", "name", src.Name)).Clicked() {
				a.showPreview(src.ID)
			}
			// 「数据表」管 agent 能看哪些表（只有 SQL 来源有），「编辑」管连接本身（只有远程来源有）。
			if src.Kind == "sql" {
				if ui.Button(c, a.tr("data.tablesBtn")).Tooltip(a.tr("data.chooseTablesTip")).Clicked() {
					a.openSourceEditor(src, false)
				}
			}
			if src.ConfigID != "" {
				if ui.Button(c, a.tr("data.edit")).Tooltip(a.tr("data.editConnTip", "name", src.Name)).Clicked() {
					a.editConnection(src)
				}
			}
			ui.PopoverMenuButton(c, a.tr("data.more"), func(m *ui.Menu) {
				if m.Item(a.tr("data.rename")).Chosen() {
					a.openSourceRename(src)
				}
				if src.Open {
					if m.Item(a.tr("data.closeSource")).Chosen() {
						a.closeSource(src)
					}
				} else if m.Item(a.tr("data.openSource")).Chosen() {
					a.openSource(src)
				}
			})
			ui.Spacer(c)
			if ui.Button(c, a.tr("data.remove")).Tooltip(a.tr("data.removeTip", "name", src.Name)).Clicked() {
				a.src.confirmKind, a.src.confirmID, a.src.confirmName = confirmSource, src.ID, src.Name
				a.src.confirmOpen = true
			}
		})
	})
}

// previewPanel 显示选中来源的预览：表选择、行数据与 schema。
func (a *app) previewPanel(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(8).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
		name := a.src.previewID
		if a.src.preview != nil && a.src.preview.SourceName != "" {
			name = a.src.preview.SourceName
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, a.tr("data.previewTitle", "name", name)).Bold().Grow(1).MinWidth(0).SingleLine()
			if a.src.previewLoading {
				ui.Spinner(c)
			}
		})
		if a.src.previewErr != "" {
			ui.Text(c, a.src.previewErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			return
		}
		if a.src.preview == nil {
			ui.Text(c, a.tr("data.loadingTables")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		if len(a.src.preview.Tables) == 0 {
			ui.Text(c, a.tr("data.noTables")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		var names []string
		for _, table := range a.src.preview.Tables {
			names = append(names, table.Name)
		}
		ui.Field(c, a.tr("data.fieldTable"), func() {
			choice := a.src.previewTable
			if choice == "" {
				choice = names[0]
			}
			if ui.Select(c, &choice, names).Label(a.tr("data.previewTable")).Changed() && choice != a.src.previewTable {
				a.src.previewTable = choice
				a.refreshPreview(a.src.previewID, choice, true)
			}
		})
		if info := previewInfo(a.src.preview, a.src.previewTable); info != nil {
			if info.TotalRows != nil {
				ui.Text(c, a.tr("data.rowsColumns", "rows", strconv.Itoa(*info.TotalRows), "columns", strconv.Itoa(len(info.Columns)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			} else {
				ui.Text(c, a.tr("data.columnsOnly", "columns", strconv.Itoa(len(info.Columns)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			}
		}
		a.previewTable(c, t)
		ui.Text(c, a.tr("data.schema")).FontSize(a.fs(textCaption)).Bold()
		if a.src.schemaErr != "" {
			ui.Text(c, a.src.schemaErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		} else if a.src.schema == "" {
			ui.Text(c, a.tr("data.noSchema")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		} else {
			a.buffer(ui.Text(c, a.src.schema)).Selectable().SingleLine()
		}
	})
}

// previewInfo 找出预览里选中的那张表的元信息。
func previewInfo(sp *service.SourcePreview, name string) *service.PreviewTableInfo {
	if sp == nil {
		return nil
	}
	for i := range sp.Tables {
		if sp.Tables[i].Name == name {
			return &sp.Tables[i]
		}
	}
	return nil
}

// previewTable 用 ui.Table 显示前 100 行。
func (a *app) previewTable(c *ui.Context, t *ui.Theme) {
	if a.src.tableErr != "" {
		ui.Text(c, a.src.tableErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		return
	}
	rows := a.src.table
	if rows == nil || len(rows.Columns) == 0 {
		ui.Text(c, a.tr("data.noRows")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		return
	}
	columns := make([]ui.TableColumn, len(rows.Columns))
	for i, name := range rows.Columns {
		columns[i] = ui.TableColumn{Title: name, ID: name, MinWidth: 80}
	}
	height := t.Space(8) * float32(len(rows.Rows)+1)
	if height > 260 {
		height = 260
	}
	ui.Table(c, nil, columns, len(rows.Rows), func(row, col int) {
		cell := ""
		if row < len(rows.Rows) && col < len(rows.Rows[row]) {
			cell = rows.Rows[row][col]
		}
		ui.Text(c, cell).SingleLine().FontSize(a.fs(textCaption))
	}).Height(height).Label(a.tr("data.previewRows"))
}

// remoteForm 是远程连接表单：类型用 Select，参数用 Field，密钥用 Password。
func (a *app) remoteForm(c *ui.Context, t *ui.Theme) {
	kind := remoteKinds[a.src.remoteKind]
	ui.Column(c).Gap(8).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Accent.Alpha(0.5)).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			title := a.tr("data.connectKind", "kind", a.kindLabel(kind))
			if a.src.remoteEditID != "" {
				title = a.tr("data.editKind", "kind", a.kindLabel(kind))
			}
			ui.Text(c, title).Bold().Grow(1).MinWidth(0)
			if ui.Button(c, a.tr("data.cancel")).Tooltip(a.tr("data.closeFormTip")).Clicked() {
				a.src.remoteOpen, a.src.remoteErr = false, ""
			}
		})
		labels := make([]string, len(remoteKinds))
		for i := range remoteKinds {
			labels[i] = a.kindLabel(remoteKinds[i])
		}
		// 改已有来源时类型和「已保存的连接」都不能换：它们决定的是新建哪个连接。
		if a.src.remoteEditID == "" {
			ui.Field(c, a.tr("data.fieldType"), func() {
				choice := a.kindLabel(kind)
				if ui.Select(c, &choice, labels).Label(a.tr("data.sourceType")).Changed() {
					for i := range remoteKinds {
						if a.kindLabel(remoteKinds[i]) == choice {
							a.startRemote(i)
							return
						}
					}
				}
			})
			if configs := configsForKind(a.src.configs, kind.ID); len(configs) > 0 {
				ui.Field(c, a.tr("data.fieldSaved"), func() {
					options := []string{a.tr("data.newConnection")}
					for _, cfg := range configs {
						options = append(options, configLabel(cfg))
					}
					choice := a.tr("data.newConnection")
					for _, cfg := range configs {
						if cfg.ID == a.src.remoteConfigID {
							choice = configLabel(cfg)
						}
					}
					if ui.Select(c, &choice, options).Label(a.tr("data.savedConnection")).Changed() {
						a.src.remoteErr = ""
						if choice == a.tr("data.newConnection") {
							a.startRemote(a.src.remoteKind)
						} else {
							for _, cfg := range configs {
								if configLabel(cfg) == choice {
									a.useConfig(cfg)
									return
								}
							}
						}
					}
				})
			}
		}
		ui.Field(c, a.tr("data.fieldName"), func() {
			ui.TextInput(c, &a.src.remoteName).Label(a.tr("data.displayName")).Placeholder(a.tr("data.optional"))
		})
		switch kind.ID {
		case "sql":
			a.sqlFields(c)
		case "gsheets":
			ui.Field(c, a.tr("data.fieldSpreadsheet"), func() {
				ui.TextInput(c, &a.src.remoteSpread).Label(a.tr("data.spreadsheetLabel")).Placeholder("https://docs.google.com/spreadsheets/d/…")
			})
			ui.Field(c, a.tr("data.fieldServiceAccount"), func() {
				input := ui.TextInput(c, &a.src.remoteCreds).Password().Label(a.tr("data.serviceAccountJSON"))
				if a.src.remoteConfigID != "" {
					input.Placeholder(a.tr("data.savedKeep"))
				} else {
					input.Placeholder(`{"type":"service_account",…}`)
				}
			})
		case "feishu":
			ui.Field(c, a.tr("data.fieldBitable"), func() {
				ui.TextInput(c, &a.src.remoteBitable).Label(a.tr("data.bitableLabel")).Placeholder("https://…/base/appToken?table=tbl…")
			})
			ui.Field(c, a.tr("data.fieldTable"), func() {
				ui.TextInput(c, &a.src.remoteTable).Label(a.tr("data.tableId")).Placeholder("tbl…")
			})
		case "http":
			ui.Field(c, a.tr("data.fieldURL"), func() {
				ui.TextInput(c, &a.src.remoteURL).Label(a.tr("data.apiURL")).Placeholder("https://api.example.com/rows")
			})
			ui.Field(c, a.tr("data.fieldAuth"), func() {
				authLabels := []string{a.tr("data.authNone"), a.tr("data.authBearer"), a.tr("data.authKey")}
				choice := authLabels[a.src.remoteAuth]
				if ui.Select(c, &choice, authLabels).Label(a.tr("data.authentication")).Changed() {
					for i := range authLabels {
						if authLabels[i] == choice {
							a.src.remoteAuth = i
							return
						}
					}
				}
			})
			if a.src.remoteAuth != 0 {
				ui.Field(c, a.tr("data.fieldSecret"), func() {
					input := ui.TextInput(c, &a.src.remoteAuthVal).Password().Label(a.tr("data.tokenLabel"))
					if a.src.remoteConfigID != "" {
						input.Placeholder(a.tr("data.savedKeep"))
					}
				})
			}
		}
		ui.Text(c, a.tr("data.credsNote")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if a.src.remoteErr != "" {
			ui.Text(c, a.src.remoteErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			submit := a.tr("data.addSource")
			if a.src.remoteEditID != "" {
				submit = a.tr("data.saveChanges")
			}
			connect := ui.PrimaryButton(c, submit)
			if a.src.remoteBusy {
				connect.Disabled(true)
				ui.Spinner(c)
			}
			if connect.Clicked() {
				a.connectRemote()
			}
			test := ui.Button(c, a.tr("data.testConn")).Tooltip(a.tr("data.testConnTip"))
			if a.src.testBusy {
				test.Disabled(true)
			}
			if test.Clicked() {
				a.testRemote()
			}
			if a.src.remoteConfigID != "" && a.src.remoteEditID == "" {
				if ui.Button(c, a.tr("data.forget")).Tooltip(a.tr("data.forgetTip")).Clicked() {
					for _, cfg := range a.src.configs {
						if cfg.ID == a.src.remoteConfigID {
							a.removeConfig(cfg)
							return
						}
					}
				}
			}
		})
		if a.src.testNote != "" {
			note := ui.Text(c, a.src.testNote).FontSize(a.fs(textCaption))
			if a.src.testFail {
				note.TextColor(t.Danger)
			} else {
				note.TextColor(t.Success)
			}
		}
	})
}

// sqlFields 是 SQL 来源的表单：按数据库类型给出主机、端口、库名、用户名与密码，
// SQLite 只要一个文件；想直接粘贴连接串的人勾选底部的开关。
func (a *app) sqlFields(c *ui.Context) {
	f := &a.src.sql
	saved := a.src.remoteConfigID != ""
	if f.advanced {
		ui.Field(c, a.tr("data.fieldConnection"), func() {
			input := ui.TextInput(c, &a.src.remoteConn).Password().Label(a.tr("data.connString"))
			if saved && f.savedConn {
				input.Placeholder(a.tr("data.savedKeep"))
			} else {
				input.Placeholder("postgresql://user:pw@host/db")
			}
		})
	} else {
		labels := make([]string, len(sqlDrivers))
		for i, d := range sqlDrivers {
			labels[i] = d.Label
		}
		ui.Field(c, a.tr("data.sqlType"), func() {
			choice := sqlDrivers[f.driver].Label
			if ui.Select(c, &choice, labels).Label(a.tr("data.sqlType")).Changed() {
				for i := range sqlDrivers {
					if sqlDrivers[i].Label == choice {
						f.driver = i
						return
					}
				}
			}
		})
		drv := sqlDrivers[f.driver]
		if drv.File {
			ui.Field(c, a.tr("data.sqlFile"), func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.TextInput(c, &f.file).Label(a.tr("data.sqlFile")).Placeholder("/path/to/data.db").Grow(1).MinWidth(0)
					if ui.Button(c, a.tr("data.sqlBrowse")).Clicked() {
						a.pickDatabaseFile()
					}
				})
			})
		} else {
			ui.Field(c, a.tr("data.sqlHost"), func() {
				ui.TextInput(c, &f.host).Label(a.tr("data.sqlHost")).Placeholder("127.0.0.1")
			})
			ui.Field(c, a.tr("data.sqlPort"), func() {
				ui.TextInput(c, &f.port).Label(a.tr("data.sqlPort")).Placeholder(drv.Port)
			})
			ui.Field(c, a.tr("data.sqlDatabase"), func() {
				ui.TextInput(c, &f.database).Label(a.tr("data.sqlDatabase"))
			})
			ui.Field(c, a.tr("data.sqlUser"), func() {
				ui.TextInput(c, &f.user).Label(a.tr("data.sqlUser"))
			})
			ui.Field(c, a.tr("data.sqlPassword"), func() {
				input := ui.TextInput(c, &f.password).Password().Label(a.tr("data.sqlPassword"))
				if saved {
					input.Placeholder(a.tr("data.savedKeep"))
				}
			})
			if drv.SSL {
				ui.Checkbox(c, &f.ssl, a.tr("data.sqlSSL"))
			}
		}
	}
	ui.Checkbox(c, &f.advanced, a.tr("data.sqlAdvanced"))
}

// configsForKind 返回某种类型的已保存配置。
func configsForKind(configs []service.SourceConfig, kind string) []service.SourceConfig {
	var out []service.SourceConfig
	for _, cfg := range configs {
		if cfg.Kind == kind {
			out = append(out, cfg)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// configLabel 是下拉框里的一条配置：有名字用名字，否则用 id。
func configLabel(cfg service.SourceConfig) string {
	if cfg.Name != "" {
		return cfg.Name
	}
	return cfg.ID
}

// workspaceTab 是「工作区」页签：挂载表单、当前挂载与已知目录。
func (a *app) workspaceTab(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(8).Children(func() {
		// 已经属于某个工作区时，下面是它的卡片与文件树；挂载新文件夹走侧栏的「New workspace」或树里的右键，这里不再放表单。
		if a.src.current == nil {
			ui.Text(c, a.tr("data.workspaceTitle")).Bold().FontSize(a.fs(textSection))
			ui.Text(c, a.tr("data.workspaceHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Field(c, a.tr("data.fieldFolder"), func() {
				ui.TextInput(c, &a.src.mountPath).Label(a.tr("data.folderToMount")).Placeholder("/home/me/data")
			})
			ui.Field(c, a.tr("data.fieldName"), func() {
				ui.TextInput(c, &a.src.mountName).Label(a.tr("data.folderName")).Placeholder(a.tr("data.optional"))
			})
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				mount := ui.PrimaryButton(c, a.tr("data.mount"))
				if a.src.mountBusy {
					mount.Disabled(true)
					ui.Spinner(c)
				}
				if mount.Clicked() {
					a.mountWorkspace()
				}
			})
		}
		if a.src.mountErr != "" {
			ui.Text(c, a.src.mountErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		if a.src.workspaceErr != "" {
			ui.Text(c, a.src.workspaceErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		if current := a.src.current; current != nil {
			ui.Column(c).Gap(6).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Accent.Alpha(0.5)).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, current.Name).Bold().Grow(1).MinWidth(0).SingleLine()
					ui.Badge(c, a.tr("data.badgeMounted"))
					if iconButton(c, icons.Settings, a.tr("ws.settings")).Clicked() {
						a.openWorkspaceSettings(current.WorkspaceID)
					}
				})
				ui.Text(c, current.Workdir).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
				// 权限模式在输入区底栏切换：这里只说明它管什么。
				ui.Text(c, a.tr("ws.modeHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
			a.fileTreeView(c, t, current)
		} else if len(a.ws.list) > 0 {
			// 普通聊天可以移入一个已有的工作区（移入后不能退出，服务端只允许单向）。
			ui.Text(c, a.tr("ws.moveHere")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		if len(a.ws.list) > 0 {
			ui.Text(c, a.tr("data.knownFolders")).Bold().FontSize(a.fs(textSection))
		}
		for _, ws := range a.ws.list {
			ws := ws
			label := ws.Name
			if label == "" {
				label = filepath.Base(ws.Workdir)
			}
			ui.Column(c).Gap(4).Padding(8).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, label).Grow(1).MinWidth(0).SingleLine()
				})
				ui.Text(c, ws.Workdir).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Tooltip(ws.Workdir)
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Spacer(c)
					// 当前对话不属于任何工作区时，可以把本对话移进去；属于某个工作区后就不能退出或改挂。
					if a.src.current == nil {
						if ui.Button(c, a.tr("ws.moveIn")).Tooltip(a.tr("ws.moveInTip", "name", label)).Clicked() {
							a.moveCurrentToWorkspace(ws.WorkspaceID)
						}
					}
					// 属于本对话的工作区没有操作；其余的可以删记录（仍有对话在用时服务端拒绝）。
					if ws.WorkspaceID == a.activeWorkspaceID() {
						ui.Badge(c, a.tr("data.badgeMounted"))
					} else if ui.Button(c, a.tr("data.remove")).Tooltip(a.tr("data.removeFolderTip", "name", label)).Clicked() {
						a.src.confirmKind, a.src.confirmID, a.src.confirmName = confirmWorkspace, ws.WorkspaceID, label
						a.src.confirmOpen = true
					}
				})
			})
		}
	})
}

// artifactsTab 是「产物」页签：列出导出文件，文本产物就地预览，HTML/SVG 用 web view 预览。
func (a *app) artifactsTab(c *ui.Context, t *ui.Theme) {
	a.chatChartsList(c, t)
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("data.artifactsTitle")).Bold().FontSize(a.fs(textSection))
		ui.Spacer(c)
		if ui.Button(c, a.tr("dash.title")).Tooltip(a.tr("data.dashboardsTip")).Clicked() {
			a.openDashboards()
		}
		if ui.Button(c, a.tr("data.refresh")).Tooltip(a.tr("data.artifactsRefreshTip")).Clicked() {
			a.loadSources()
		}
	})
	if a.src.artifactsErr != "" {
		ui.Text(c, a.src.artifactsErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
	}
	if len(a.src.artifacts) == 0 {
		ui.Text(c, a.tr("data.noArtifacts")).TextColor(t.TextMuted)
		return
	}
	for _, art := range a.src.artifacts {
		ui.Column(c).Gap(4).Padding(8).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, art.Name).Grow(1).MinWidth(0).SingleLine().Tooltip(art.Name)
				ui.Badge(c, art.Root)
			})
			ui.Textf(c, "%s · %s", formatBytes(art.Size), art.Modified).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Spacer(c)
				switch {
				case htmlArtifact(art.Name):
					if ui.Button(c, a.tr("data.preview")).Tooltip(a.tr("data.showHereTip", "name", art.Name)).Clicked() {
						a.showHTMLArtifact(art)
					}
				case diagramFile(art.Name):
					if ui.Button(c, a.tr("dash.open")).Tooltip(a.tr("dash.openDrawioTip", "name", art.Name)).Clicked() {
						c.OpenURL(preview.FileURL(art.Path))
					}
				case textArtifact(art.Name):
					if ui.Button(c, a.tr("data.preview")).Tooltip(a.tr("data.readHereTip", "name", art.Name)).Clicked() {
						a.previewArtifact(art)
					}
				default:
					ui.Text(c, a.tr("data.openPathHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				}
			})
			if a.src.artifactName == art.Name {
				if htmlArtifact(art.Name) {
					a.artifactPreviewCard(c, art)
				} else {
					switch {
					case a.src.artifactErr != "":
						ui.Text(c, a.src.artifactErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
					case !a.src.artifactLoaded:
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Spinner(c)
							ui.Text(c, a.tr("data.reading")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
						})
					default:
						a.buffer(ui.Text(c, a.src.artifactText)).Selectable()
					}
				}
			}
			ui.Text(c, art.Path).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable().SingleLine().Tooltip(art.Path)
		})
	}
}

// textArtifact 判断产物是否适合内联预览（服务端只给这些类型的正文）。
func textArtifact(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".csv", ".tsv", ".json", ".md", ".txt", ".html", ".svg":
		return true
	}
	return false
}

// sourceModals 构建确认与编辑对话框。
func (a *app) sourceModals(c *ui.Context, t *ui.Theme) {
	if a.src.confirmOpen {
		ui.Modal(c, &a.src.confirmOpen, func() {
			switch a.src.confirmKind {
			case confirmSource:
				ui.Text(c, a.tr("data.confirmSource")).Bold()
				ui.Textf(c, "%s will be disconnected. Its uploaded copy is deleted; files in a mounted folder stay.", a.src.confirmName).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, a.tr("data.cancel")).Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, a.tr("data.removeSource")).Clicked() {
						a.src.confirmOpen = false
						for _, src := range a.src.sources {
							if src.ID == a.src.confirmID {
								a.removeSource(src)
								return
							}
						}
					}
				})
			case confirmSourceAll:
				ui.Text(c, a.tr("data.confirmAll")).Bold()
				ui.Text(c, a.tr("data.confirmAllHint")).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, a.tr("data.cancel")).Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, a.tr("data.removeAll")).Clicked() {
						a.src.confirmOpen = false
						a.removeAllSources()
					}
				})
			case confirmWorkspace:
				ui.Text(c, a.tr("data.confirmFolder")).Bold()
				ui.Textf(c, "%s is removed from this chat. The folder and its files are not deleted.", a.src.confirmName).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, a.tr("data.cancel")).Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, a.tr("data.removeFolder")).Clicked() {
						a.src.confirmOpen = false
						a.removeWorkspace(a.src.confirmID)
					}
				})
			default:
				a.src.confirmOpen = false
			}
		})
	}
	if a.src.renameOpen {
		a.renameModal(c, t)
	}
	if a.src.editOpen {
		a.editModal(c, t)
	}
}

// renameModal 是来源改名对话框。
func (a *app) renameModal(c *ui.Context, t *ui.Theme) {
	ui.Modal(c, &a.src.renameOpen, func() {
		ui.Column(c).WidthPercent(70).MaxWidth(420).MinWidth(260).Gap(10).Children(func() {
			ui.Text(c, a.tr("data.renameTitle")).Bold()
			in := ui.TextInput(c, &a.src.renameText).Label(a.tr("data.nameLabel")).MaxWidth(380).AutoFocus()
			if a.src.renameErr != "" {
				ui.Text(c, a.src.renameErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if a.src.renameBusy {
					ui.Spinner(c)
				}
				if ui.Button(c, a.tr("data.cancel")).Disabled(a.src.renameBusy).Clicked() {
					a.src.renameOpen = false
				}
				if ui.PrimaryButton(c, a.tr("chat.save")).Disabled(a.src.renameBusy).Clicked() || in.Submitted() {
					a.renameSource()
				}
			})
		})
	})
}

// editModal 是 SQL 来源的选表对话框：选出允许 agent 分析的数据表。连接本身的修改在来源卡片的「编辑」里。
func (a *app) editModal(c *ui.Context, t *ui.Theme) {
	var src service.Source
	found := false
	for _, item := range a.src.sources {
		if item.ID == a.src.editID {
			src, found = item, true
			break
		}
	}
	if !found {
		a.src.editOpen = false
		return
	}
	ui.Modal(c, &a.src.editOpen, func() {
		ui.Text(c, a.tr("data.sourceTitle", "name", src.Name)).Bold()
		ui.Text(c, a.tr("data.kindTables", "kind", src.Kind, "count", strconv.Itoa(len(src.Tables)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if a.src.editBusy {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Spinner(c)
				ui.Text(c, a.tr("data.readingTables")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
			return
		}
		ui.Text(c, a.tr("data.analyseTables")).Bold()
		if len(a.src.editTables) == 0 {
			ui.Text(c, a.tr("data.sourceNoTables")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		ui.Text(c, a.tr("data.pickHint", "max", strconv.Itoa(maxAnalysisTables))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		ui.Scroll(c).Height(220).Children(func() {
			ui.Column(c).Gap(4).Children(func() {
				for _, name := range a.src.editTables {
					on := a.src.editPicked[name]
					if ui.Checkbox(c, &on, name).Changed() {
						a.src.editPicked[name] = on
					}
				}
			})
		})
		if a.src.editErr != "" {
			ui.Text(c, a.src.editErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		picked := 0
		for _, name := range a.src.editTables {
			if a.src.editPicked[name] {
				picked++
			}
		}
		count := ui.Text(c, a.tr("data.pickedCount", "count", strconv.Itoa(picked), "max", strconv.Itoa(maxAnalysisTables))).FontSize(a.fs(textCaption))
		if picked > maxAnalysisTables {
			count.TextColor(t.Danger)
		} else {
			count.TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
			if ui.Button(c, a.tr("data.cancel")).Clicked() {
				a.src.editOpen = false
			}
			save := ui.PrimaryButton(c, a.tr("data.saveTables"))
			if picked > maxAnalysisTables {
				save.Disabled(true)
			}
			if save.Clicked() {
				a.saveSourceTables()
			}
		})
	})
}

// chatChartsList 是「产出物」标签顶部的一节：这个对话里生成的全部图表，点一下全屏查看。
func (a *app) chatChartsList(c *ui.Context, t *ui.Theme) {
	var charts []conversation.Chart
	for _, m := range a.chat.Messages {
		if m.Tool != nil {
			charts = append(charts, m.Tool.Charts...)
		}
	}
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("data.charts")).Bold().FontSize(a.fs(textSection))
		ui.Text(c, strconv.Itoa(len(charts))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	})
	if len(charts) == 0 {
		ui.Text(c, a.tr("data.noCharts")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		return
	}
	tok := a.tokens().Tok
	for _, ch := range charts {
		title := ch.Title
		if title == "" {
			title = a.tr("chat.chart")
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(8, 10).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
			ui.Icon(c, icons.Chart).TextColor(t.TextMuted)
			ui.Text(c, title).SingleLine().Grow(1).MinWidth(0).Tooltip(title)
			if ch.Type != "" {
				ui.Badge(c, ch.Type)
			}
			if iconButton(c, icons.Maximize, a.tr("chat.fullScreen")).Clicked() {
				a.openFullChart(ch)
			}
		})
	}
}
