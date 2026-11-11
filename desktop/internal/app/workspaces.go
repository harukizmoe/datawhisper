package app

// 工作区的界面状态与动作：侧栏分组用的索引、「New workspace」对话框、新建对话时选的归属工作区。
// 工作区本身存在服务端（<数据目录>/workspaces.json）；这里只放界面需要的副本与编辑中的表单。

import (
	"context"
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// workspaceIndex 是工作区数据的唯一来源：侧栏、新对话选择器与数据面板都读它，服务端的变化只经 loadWorkspaces 进来。
type workspaceIndex struct {
	// list 是全部工作区记录；scopes 把对话映射到工作区（普通聊天不出现）。
	list   []service.Workspace
	scopes map[int]string
	// folded 记着哪些工作区在侧栏里被折叠（本次运行内）；没出现过的默认展开。
	folded map[string]bool
	err    string
}

// workspaceDialog 是「New workspace」对话框的状态。
type workspaceDialog struct {
	open         bool
	path         string
	name         string
	instructions string
	busy         bool
	err          string
}

// newScope 是下一条新对话要归属的工作区 id；空串表示普通聊天。沿用上次的选择。
func (a *app) newScope() string { return a.newChatScope }

// setNewScope 切换下一条新对话的归属；已经在工作区列表里消失的 id 退回普通聊天。
func (a *app) setNewScope(workspaceID string) {
	if workspaceID != "" && a.workspaceByID(workspaceID) == nil {
		workspaceID = ""
	}
	a.newChatScope = workspaceID
}

// workspaceByID 在索引里找工作区；找不到时返回 nil。
func (a *app) workspaceByID(workspaceID string) *service.Workspace {
	for i := range a.ws.list {
		if a.ws.list[i].WorkspaceID == workspaceID {
			return &a.ws.list[i]
		}
	}
	return nil
}

// workspaceName 是工作区的显示名；记录不在（已被移除）时退回 id。
func (a *app) workspaceName(workspaceID string) string {
	if record := a.workspaceByID(workspaceID); record != nil && record.Name != "" {
		return record.Name
	}
	return workspaceID
}

// scopeOf 返回对话所属的工作区 id；普通聊天返回空串。
func (a *app) scopeOf(conversationID int) string { return a.ws.scopes[conversationID] }

// loadWorkspaces 拉取工作区列表与对话归属；侧栏分组与新对话选择器都用它。
func (a *app) loadWorkspaces() {
	client, conv := a.client, a.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		list, listErr := client.Workspaces(ctx, conv)
		scopes, scopesErr := client.ConversationScopes(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			if listErr != nil {
				a.ws.err = a.sourceErr(listErr)
				return
			}
			if scopesErr != nil {
				a.ws.err = a.sourceErr(scopesErr)
				return
			}
			a.ws.list, a.ws.err = list.Workspaces, ""
			a.ws.scopes = make(map[int]string, len(scopes))
			for _, entry := range scopes {
				a.ws.scopes[entry.ConversationID] = entry.WorkspaceID
			}
		})
	}()
}

// openWorkspaceDialog 打开「New workspace」对话框；预填已经选中的文件夹。
func (a *app) openWorkspaceDialog(path string) {
	a.wsDlg = workspaceDialog{open: true, path: path}
}

// pickWorkspaceFolder 用系统的选目录对话框填路径。
func (a *app) pickWorkspaceFolder() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Title:     a.tr("ws.chooseTitle"),
			Message:   a.tr("ws.chooseMsg"),
			Directory: true,
		})
		if err != nil {
			a.post(func() { a.wsDlg.err = a.tr("data.dialogUnavailable", "error", err.Error()) })
			return
		}
		if len(paths) == 0 {
			return // 用户取消
		}
		a.post(func() { a.wsDlg.path = paths[0] })
	}()
}

// createWorkspace 登记目录并建立工作区；成功后新对话的默认归属切到它。
func (a *app) createWorkspace() {
	client := a.client
	if client == nil || a.wsDlg.busy {
		return
	}
	path := a.wsDlg.path
	if path == "" {
		a.wsDlg.err = a.tr("ws.enterFolder")
		return
	}
	a.wsDlg.busy, a.wsDlg.err = true, ""
	name := a.wsDlg.name
	instructions := a.wsDlg.instructions
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		out, err := client.CreateWorkspace(ctx, path, name, instructions)
		a.post(func() {
			if client != a.client {
				return
			}
			a.wsDlg.busy = false
			if err != nil {
				a.wsDlg.err = a.sourceErr(err)
				return
			}
			a.wsDlg.open = false
			// 新工作区先进索引，`setNewScope` 才认得它（列表刷新是另一次往返）。
			if out.Workspace != nil {
				if a.workspaceByID(out.Workspace.WorkspaceID) == nil {
					a.ws.list = append(a.ws.list, *out.Workspace)
				}
				a.setNewScope(out.Workspace.WorkspaceID)
			}
			a.ws.err = ""
			a.loadWorkspaces()
			if len(out.Errors) > 0 {
				a.src.notice, a.src.noticeErr = a.tr("data.mountedSkipped", "label", out.Workspace.Name, "skipped", strings.Join(out.Errors, "; ")), true
			}
		})
	}()
}

// moveCurrentToWorkspace 把当前普通聊天移入工作区，并刷新侧栏与权限状态。
func (a *app) moveCurrentToWorkspace(workspaceID string) {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_, err := client.MoveToWorkspace(ctx, conv, workspaceID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.ws.err = a.sourceErr(err)
				return
			}
			a.ws.err = ""
			a.loadWorkspaces()
			a.loadPermissions()
			a.loadSources()
		})
	}()
}

// workspaceRow 是侧栏里的一个工作区：记录加上它名下的会话（可以是空的）。
type workspaceRow struct {
	id       string
	name     string
	missing  bool // 目录不在了（被移走或卸载）
	sessions []service.Session
}

// workspaceRows 列出侧栏里的全部工作区，空的也列：工作区是一等对象，刚建好、还没有对话时也要看得见、点得到。
// 归档的会话不列；搜索框有字时只留名称或会话标题命中的工作区。
func (a *app) workspaceRows() []workspaceRow {
	query := strings.ToLower(strings.TrimSpace(a.sideSearch))
	byWorkspace := map[string][]service.Session{}
	for _, s := range a.sessions {
		if workspaceID := a.scopeOf(s.ID); workspaceID != "" && !s.Archived {
			byWorkspace[workspaceID] = append(byWorkspace[workspaceID], s)
		}
	}
	var rows []workspaceRow
	for _, ws := range a.ws.list {
		row := workspaceRow{id: ws.WorkspaceID, name: a.workspaceName(ws.WorkspaceID), missing: !ws.Available}
		nameHit := query == "" || strings.Contains(strings.ToLower(row.name), query)
		for _, s := range byWorkspace[ws.WorkspaceID] {
			if nameHit || strings.Contains(strings.ToLower(a.sessionTitle(s.ID)), query) {
				row.sessions = append(row.sessions, s)
			}
		}
		if nameHit || len(row.sessions) > 0 {
			rows = append(rows, row)
		}
	}
	return rows
}

// workspaceSection 画侧栏的工作区区：标题行（带新建按钮），然后每个工作区一行——折叠箭头、强调色文件夹图标、
// 加粗的名字、右边的「在这里新建对话」；名下的会话缩进在左侧引导线后面。空工作区写明还没有对话。
// 它在 Sidebar 里面，所以会话条目照常参与键盘导航。
func (a *app) workspaceSection(c *ui.Context, t *ui.Theme) {
	rows := a.workspaceRows()
	ui.Row(c).AlignItems(ui.Center).Padding(6, 4, 2, 8).Children(func() {
		ui.Text(c, a.tr("ws.section")).FontSize(a.fs(textCaption)).Bold().TextColor(t.TextMuted).Grow(1).MinWidth(0).SingleLine()
		if ghostIconButton(c, icons.Plus, a.tr("ws.new")).Clicked() {
			a.openWorkspaceDialog("")
		}
	})
	if len(rows) == 0 && a.sideSearch == "" {
		if ui.ButtonBase(c).Label(a.tr("ws.emptyHint")).Padding(6, 8).Radius(8).Justify(ui.Start).Children(func() {
			ui.Icon(c, icons.FolderOpen).TextColor(t.TextMuted)
			ui.Text(c, a.tr("ws.emptyHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}).Clicked() {
			a.openWorkspaceDialog("")
		}
		return
	}
	active := a.activeWorkspaceID()
	for _, row := range rows {
		row := row
		folded := a.ws.folded[row.id]
		chevron := icons.ChevronDown
		if folded {
			chevron = icons.ChevronRight
		}
		ui.Row(c).Gap(2).AlignItems(ui.Center).Children(func() {
			header := ui.ButtonBase(c).Label(row.name).Grow(1).MinWidth(0).Justify(ui.Start).Gap(6).Padding(6, 8).Radius(8)
			if row.id == active {
				header = header.Background(t.Accent.Alpha(0.12))
			}
			header.Children(func() {
				ui.Icon(c, chevron).TextColor(t.TextMuted)
				icon := ui.Icon(c, icons.FolderOpen).TextColor(t.Accent)
				name := ui.Text(c, row.name).Bold().SingleLine().Grow(1).MinWidth(0)
				if row.missing {
					icon.TextColor(t.Warning)
					name.TextColor(t.Warning).Tooltip(a.tr("ws.missing"))
				}
			})
			if header.Clicked() {
				if a.ws.folded == nil {
					a.ws.folded = map[string]bool{}
				}
				a.ws.folded[row.id] = !folded
			}
			if ghostIconButton(c, icons.Plus, a.tr("ws.newChatIn", "name", row.name)).Disabled(row.missing).Clicked() {
				a.newChatInWorkspace(row.id)
			}
		})
		if folded {
			continue
		}
		ui.Column(c).Margin(0, 0, 4, 16).Padding(0, 0, 0, 6).BorderWidth(0, 0, 0, 1).BorderColor(t.Border).Children(func() {
			if len(row.sessions) == 0 {
				ui.Text(c, a.tr("ws.noChats")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(4, 8)
			}
			for _, session := range row.sessions {
				a.sessionItem(c, session)
			}
		})
	}
}

// activeWorkspaceID 是当前界面所处的工作区：打开着的对话所属的那个；还没有对话时是下一条新对话要进的那个。
func (a *app) activeWorkspaceID() string {
	if a.conv == 0 {
		return a.newScope()
	}
	if id := a.perm.scope.WorkspaceID; id != "" {
		return id
	}
	return a.scopeOf(a.conv)
}

// newChatInWorkspace 切到一个归属为该工作区的空白新对话；真正的对话在发出第一条消息时才创建。
func (a *app) newChatInWorkspace(workspaceID string) {
	a.setNewScope(workspaceID)
	a.newChat()
	a.cv.wantFocus = true
}

// scopeChip 是输入框底栏里的范围芯片：还没有对话时选下一条对话属于普通聊天还是某个工作区；已有的普通
// 聊天里把它移入工作区（单向）。已经属于工作区的对话不画它——工作区名在标题栏，模式芯片管权限。
func (a *app) scopeChip(c *ui.Context) {
	label := a.tr("ws.scopeChat")
	current := a.newScope()
	if a.conv == 0 && current != "" {
		label = a.workspaceName(current)
	}
	ui.PopoverMenuButton(c, label, func(m *ui.Menu) {
		a.menuShown()
		if a.conv == 0 {
			if m.Item(a.tr("ws.scopeChat")).Radio(current == "").Chosen() {
				a.setNewScope("")
			}
			for i := range a.ws.list {
				if m.Item(a.ws.list[i].Name).Radio(a.ws.list[i].WorkspaceID == current).Chosen() {
					a.setNewScope(a.ws.list[i].WorkspaceID)
				}
			}
			m.Separator()
			if m.Item(a.tr("ws.newItem")).Chosen() {
				a.openWorkspaceDialog("")
			}
			return
		}
		m.Submenu(a.tr("ws.moveMenu"), func(sub *ui.Menu) {
			for i := range a.ws.list {
				if sub.Item(a.ws.list[i].Name).Disabled(!a.ws.list[i].Available).Chosen() {
					a.moveCurrentToWorkspace(a.ws.list[i].WorkspaceID)
				}
			}
		}).Disabled(len(a.ws.list) == 0)
	}).FontSize(a.fs(textCaption)).Shrink(0).Tooltip(a.tr("ws.chipTip"))
}

// workspaceDialogView 画「New workspace」对话框。
func (a *app) workspaceDialogView(c *ui.Context) {
	if !a.wsDlg.open {
		return
	}
	t := c.Theme()
	ui.Modal(c, &a.wsDlg.open, func() {
		ui.Column(c).WidthPercent(70).MaxWidth(480).MinWidth(300).Gap(10).Children(func() {
			ui.Text(c, a.tr("ws.dialogTitle")).Bold()
			ui.Field(c, a.tr("data.fieldFolder"), func() {
				ui.Row(c).Gap(6).AlignItems(ui.End).Children(func() {
					ui.TextInput(c, &a.wsDlg.path).Label(a.tr("ws.folder")).Placeholder("/home/me/project").Grow(1).MinWidth(0).AutoFocus()
					if ui.Button(c, a.tr("ws.browse")).Tooltip(a.tr("ws.browseTip")).Shrink(0).Clicked() {
						a.pickWorkspaceFolder()
					}
				})
			})
			ui.Field(c, a.tr("data.fieldName"), func() {
				ui.TextInput(c, &a.wsDlg.name).Label(a.tr("ws.name")).Placeholder(a.tr("data.optional"))
			})
			ui.Field(c, a.tr("ws.instructions"), func() {
				ui.TextArea(c, &a.wsDlg.instructions).Label(a.tr("ws.instructionsLabel")).Placeholder(a.tr("ws.instructionsHint")).Lines(3, 8)
			})
			ui.Text(c, a.tr("ws.dialogHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			if a.wsDlg.err != "" {
				ui.Text(c, a.wsDlg.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).AlignItems(ui.Center).Children(func() {
				if a.wsDlg.busy {
					ui.Spinner(c)
				}
				if ui.Button(c, a.tr("chat.cancel")).Disabled(a.wsDlg.busy).Clicked() {
					a.wsDlg.open = false
				}
				if ui.PrimaryButton(c, a.tr("ws.create")).Disabled(a.wsDlg.busy).Clicked() {
					a.createWorkspace()
				}
			})
		})
	})
}
