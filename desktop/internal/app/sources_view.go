package app

// 数据面板的界面：数据源、工作区、产物三个标签页，预览表格、远程连接表单与编辑弹窗。状态与动作在 sources.go。

import (
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// sourcesPanel 构建右侧的数据面板。
func (a *app) sourcesPanel(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).Background(t.Background).BorderWidth(0, 0, 0, 1).BorderColor(t.Border).Children(func() {
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
		ui.Tabs(c, &a.src.tab, a.tr("data.tabSources"), a.tr("data.tabWorkspace"), a.tr("data.tabArtifacts")).Label(a.tr("data.tabsLabel")).Changed()
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
		ui.MenuButton(c, a.tr("data.connect"), func(m *ui.Menu) {
			for i := range remoteKinds {
				i := i
				if m.Item(remoteKinds[i].Label).Chosen() {
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
			ui.Progress(c, a.src.uploadProgress).Label("Import progress")
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
		})
		state := a.tr("data.stateClosed")
		if src.Open {
			state = a.tr("data.stateOpen")
		}
		ui.Text(c, a.tr("data.tables", "count", strconv.Itoa(len(src.Tables)), "state", state)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			active := src.Active
			ui.Switch(c, &active).Label("Use " + src.Name + " in analysis").Changed()
			if active != src.Active {
				a.setSourceActive(src, active)
			}
			ui.Text(c, a.tr("data.inAnalysis")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Spacer(c)
			if ui.Button(c, a.tr("data.preview")).Tooltip(a.tr("data.previewTip", "name", src.Name)).Clicked() {
				a.showPreview(src.ID)
			}
			if ui.Button(c, a.tr("data.edit")).Tooltip(a.tr("data.editTip", "name", src.Name)).Clicked() {
				a.openSourceEditor(src)
			}
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
		ui.Field(c, "Table", func() {
			choice := a.src.previewTable
			if choice == "" {
				choice = names[0]
			}
			if ui.Select(c, &choice, names).Label("Preview table").Changed() && choice != a.src.previewTable {
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
	}).Height(height).Label("Preview rows")
}

// remoteForm 是远程连接表单：类型用 Select，参数用 Field，密钥用 Password。
func (a *app) remoteForm(c *ui.Context, t *ui.Theme) {
	kind := remoteKinds[a.src.remoteKind]
	ui.Column(c).Gap(8).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Accent.Alpha(0.5)).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Connect "+kind.Label).Bold().Grow(1).MinWidth(0)
			if ui.Button(c, "Cancel").Tooltip("Close the connection form").Clicked() {
				a.src.remoteOpen, a.src.remoteErr = false, ""
			}
		})
		labels := make([]string, len(remoteKinds))
		for i := range remoteKinds {
			labels[i] = remoteKinds[i].Label
		}
		ui.Field(c, "Type", func() {
			choice := kind.Label
			if ui.Select(c, &choice, labels).Label("Source type").Changed() {
				for i := range remoteKinds {
					if remoteKinds[i].Label == choice {
						a.startRemote(i)
						return
					}
				}
			}
		})
		if configs := configsForKind(a.src.configs, kind.ID); len(configs) > 0 {
			ui.Field(c, "Saved", func() {
				options := []string{"New connection"}
				for _, cfg := range configs {
					options = append(options, configLabel(cfg))
				}
				choice := "New connection"
				for _, cfg := range configs {
					if cfg.ID == a.src.remoteConfigID {
						choice = configLabel(cfg)
					}
				}
				if ui.Select(c, &choice, options).Label("Saved connection").Changed() {
					a.src.remoteErr = ""
					if choice == "New connection" {
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
		ui.Field(c, "Name", func() {
			ui.TextInput(c, &a.src.remoteName).Label("Display name").Placeholder("Optional")
		})
		switch kind.ID {
		case "sql":
			ui.Field(c, "Connection", func() {
				input := ui.TextInput(c, &a.src.remoteConn).Password().Label("Connection string")
				if a.src.remoteConfigID != "" {
					input.Placeholder("Saved: leave empty to keep it")
				} else {
					input.Placeholder("postgresql://user:pw@host/db")
				}
			})
		case "gsheets":
			ui.Field(c, "Spreadsheet", func() {
				ui.TextInput(c, &a.src.remoteSpread).Label("Spreadsheet URL or id").Placeholder("https://docs.google.com/spreadsheets/d/…")
			})
			ui.Field(c, "Service account", func() {
				input := ui.TextInput(c, &a.src.remoteCreds).Password().Label("Service account JSON")
				if a.src.remoteConfigID != "" {
					input.Placeholder("Saved: leave empty to keep it")
				} else {
					input.Placeholder(`{"type":"service_account",…}`)
				}
			})
		case "feishu":
			ui.Field(c, "Bitable", func() {
				ui.TextInput(c, &a.src.remoteBitable).Label("Bitable link or app_token").Placeholder("https://…/base/appToken?table=tbl…")
			})
			ui.Field(c, "Table", func() {
				ui.TextInput(c, &a.src.remoteTable).Label("Table id").Placeholder("tbl…")
			})
		case "http":
			ui.Field(c, "URL", func() {
				ui.TextInput(c, &a.src.remoteURL).Label("API URL").Placeholder("https://api.example.com/rows")
			})
			ui.Field(c, "Auth", func() {
				authLabels := []string{"None", "Bearer token", "API key"}
				choice := authLabels[a.src.remoteAuth]
				if ui.Select(c, &choice, authLabels).Label("Authentication").Changed() {
					for i := range authLabels {
						if authLabels[i] == choice {
							a.src.remoteAuth = i
							return
						}
					}
				}
			})
			if a.src.remoteAuth != 0 {
				ui.Field(c, "Secret", func() {
					input := ui.TextInput(c, &a.src.remoteAuthVal).Password().Label("Token or API key")
					if a.src.remoteConfigID != "" {
						input.Placeholder("Saved: leave empty to keep it")
					}
				})
			}
		}
		ui.Text(c, "Credentials go to the service and never come back to this window.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if a.src.remoteErr != "" {
			ui.Text(c, a.src.remoteErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			connect := ui.PrimaryButton(c, "Add source")
			if a.src.remoteBusy {
				connect.Disabled(true)
				ui.Spinner(c)
			}
			if connect.Clicked() {
				a.connectRemote()
			}
			if a.src.remoteConfigID != "" {
				if ui.Button(c, "Forget").Tooltip("Remove the saved connection").Clicked() {
					for _, cfg := range a.src.configs {
						if cfg.ID == a.src.remoteConfigID {
							a.removeConfig(cfg)
							return
						}
					}
				}
			}
		})
	})
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
		ui.Text(c, "Workspace").Bold().FontSize(a.fs(textSection))
		ui.Text(c, "The agent reads the files in this folder and writes exports to its artifacts folder.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		ui.Field(c, "Folder", func() {
			ui.TextInput(c, &a.src.mountPath).Label("Folder to mount").Placeholder("/home/me/data")
		})
		ui.Field(c, "Name", func() {
			ui.TextInput(c, &a.src.mountName).Label("Folder name").Placeholder("Optional")
		})
		ui.Field(c, "Permission", func() {
			perm := workspacePermissionLabels[a.src.mountPerm]
			if ui.Select(c, &perm, workspacePermissionLabels).Label("Workspace permission").Changed() {
				a.src.mountPerm = permissionIndex(permissionValueForLabel(perm))
			}
		})
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			mount := ui.PrimaryButton(c, "Mount")
			if a.src.mountBusy {
				mount.Disabled(true)
				ui.Spinner(c)
			}
			if mount.Clicked() {
				a.mountWorkspace()
			}
		})
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
					ui.Badge(c, "mounted")
				})
				ui.Text(c, current.Workdir).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
				ui.Field(c, "Permission", func() {
					perm := workspacePermissionLabels[permissionIndex(current.Permission)]
					if ui.Select(c, &perm, workspacePermissionLabels).Label("Permission of "+current.Name).Changed() && perm != workspacePermissionLabels[permissionIndex(current.Permission)] {
						a.setWorkspacePermission(current.WorkspaceID, permissionValueForLabel(perm))
					}
				})
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					if a.src.permBusy == current.WorkspaceID {
						ui.Spinner(c)
					}
					ui.Spacer(c)
					if ui.Button(c, "Unmount").Tooltip("Stop using this folder").Clicked() {
						a.unmountWorkspace(current.WorkspaceID)
					}
				})
			})
		}
		if len(a.src.workspaces) > 0 {
			ui.Text(c, "Known folders").Bold().FontSize(a.fs(textSection))
		}
		for _, ws := range a.src.workspaces {
			ws := ws
			label := ws.Name
			if label == "" {
				label = filepath.Base(ws.Workdir)
			}
			ui.Column(c).Gap(4).Padding(8).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, label).Grow(1).MinWidth(0).SingleLine()
					ui.Badge(c, permissionLabel(ws.Permission))
				})
				ui.Text(c, ws.Workdir).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Tooltip(ws.Workdir)
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Spacer(c)
					if ws.Mounted {
						if ui.Button(c, "Unmount").Tooltip("Unmount " + label).Clicked() {
							a.unmountWorkspace(ws.WorkspaceID)
						}
					} else if ui.Button(c, "Remove").Tooltip("Remove " + label + " from this chat").Clicked() {
						a.src.confirmKind, a.src.confirmID, a.src.confirmName = confirmWorkspace, ws.WorkspaceID, label
						a.src.confirmOpen = true
					}
				})
			})
		}
	})
}

// permissionIndex 把服务端的权限值映射成 Select 的下标。
func permissionIndex(permission string) int {
	if permission == "read_write" {
		return 1
	}
	return 0
}

// permissionValueForLabel 把 Select 的标签翻回服务端的权限值。
func permissionValueForLabel(label string) string {
	if label == workspacePermissionLabels[1] {
		return "read_write"
	}
	return "read_only"
}

// permissionLabel 给列表用的短标签。
func permissionLabel(permission string) string {
	if permission == "read_write" {
		return "read & write"
	}
	return "read only"
}

// artifactsTab 是「产物」页签：列出导出文件，文本产物就地预览，HTML/SVG 用 web view 预览。
func (a *app) artifactsTab(c *ui.Context, t *ui.Theme) {
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "Artifacts").Bold().FontSize(a.fs(textSection))
		ui.Spacer(c)
		if ui.Button(c, "Dashboards").Tooltip("View this machine's dashboards read-only").Clicked() {
			a.openDashboards()
		}
		if ui.Button(c, "Canvas").Tooltip("Open diagram files from this chat's artifacts").Clicked() {
			a.openCanvas()
		}
		if ui.Button(c, "Refresh").Tooltip("Reload the artifact list").Clicked() {
			a.loadSources()
		}
	})
	if a.src.artifactsErr != "" {
		ui.Text(c, a.src.artifactsErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
	}
	if len(a.src.artifacts) == 0 {
		ui.Text(c, "No artifacts yet: ask the agent to export a table or chart.").TextColor(t.TextMuted)
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
					if ui.Button(c, "Preview").Tooltip("Show " + art.Name + " here").Clicked() {
						a.showHTMLArtifact(art)
					}
				case diagramFile(art.Name):
					if ui.Button(c, "Open").Tooltip("Open " + art.Name + " with the system's draw.io").Clicked() {
						c.OpenURL(preview.FileURL(art.Path))
					}
				case textArtifact(art.Name):
					if ui.Button(c, "Preview").Tooltip("Read " + art.Name + " here").Clicked() {
						a.previewArtifact(art)
					}
				default:
					ui.Text(c, "Open the path to view it").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
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
							ui.Text(c, "Reading…").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
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
				ui.Text(c, "Remove this data source?").Bold()
				ui.Textf(c, "%s will be disconnected. Its uploaded copy is deleted; files in a mounted folder stay.", a.src.confirmName).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, "Cancel").Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, "Remove source").Clicked() {
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
				ui.Text(c, "Remove all data sources?").Bold()
				ui.Text(c, "Every source of this chat is disconnected, and mounted folders are unmounted. Files on disk stay.").TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, "Cancel").Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, "Remove all").Clicked() {
						a.src.confirmOpen = false
						a.removeAllSources()
					}
				})
			case confirmWorkspace:
				ui.Text(c, "Remove this folder?").Bold()
				ui.Textf(c, "%s is removed from this chat. The folder and its files are not deleted.", a.src.confirmName).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, "Cancel").Clicked() {
						a.src.confirmOpen = false
					}
					if ui.PrimaryButton(c, "Remove folder").Clicked() {
						a.src.confirmOpen = false
						a.removeWorkspace(a.src.confirmID)
					}
				})
			default:
				a.src.confirmOpen = false
			}
		})
	}
	if a.src.editOpen {
		a.editModal(c, t)
	}
}

// editModal 编辑一个来源：SQL 来源在这里选分析表，任何来源都能在这里开关。
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
		ui.Text(c, "Source: "+src.Name).Bold()
		ui.Textf(c, "%s · %d tables", src.Kind, len(src.Tables)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if src.Open {
			if ui.Button(c, "Close source").Tooltip("Close it in the compute worker").Clicked() {
				a.src.editOpen = false
				a.closeSource(src)
			}
		} else {
			if ui.Button(c, "Open source").Tooltip("Open it in the compute worker").Clicked() {
				a.src.editOpen = false
				a.openSource(src)
			}
		}
		if src.Kind != "sql" {
			ui.Text(c, "Only a SQL source chooses which tables the agent may analyse.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					a.src.editOpen = false
				}
			})
			return
		}
		if a.src.editBusy {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Spinner(c)
				ui.Text(c, "Reading the tables…").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
			return
		}
		ui.Text(c, "Tables the agent may analyse").Bold()
		if len(a.src.editTables) == 0 {
			ui.Text(c, "This source reports no tables.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
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
		ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
			if ui.Button(c, "Cancel").Clicked() {
				a.src.editOpen = false
			}
			if ui.PrimaryButton(c, "Save tables").Clicked() {
				a.saveSourceTables()
			}
		})
	})
}
