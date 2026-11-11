package app

// 工作区的界面状态与动作：侧栏分组用的索引、「New workspace」对话框、新建对话时选的归属工作区。
// 工作区本身存在服务端（<数据目录>/workspaces.json）；这里只放界面需要的副本与编辑中的表单。

import (
	"context"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// workspaceIndex 是侧栏与新对话选择器共用的工作区索引。
type workspaceIndex struct {
	// list 是全部工作区记录；scopes 把对话映射到工作区（普通聊天不出现）。
	list   []service.Workspace
	scopes map[int]string
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

// workspaceGroups 是侧栏里按工作区分出的组：每组一个工作区，只列有会话的那些（空工作区不影响使用，
// 新对话时在选择器里能选到它）。归档的与搜索不匹配的不列出。
func (a *app) workspaceGroups(now time.Time) []sessionGroup {
	query := strings.ToLower(strings.TrimSpace(a.sideSearch))
	byWorkspace := map[string][]service.Session{}
	for _, s := range a.sessions {
		if s.Archived {
			continue
		}
		workspaceID := a.scopeOf(s.ID)
		if workspaceID == "" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(a.sessionTitle(s.ID)), query) {
			continue
		}
		byWorkspace[workspaceID] = append(byWorkspace[workspaceID], s)
	}
	var out []sessionGroup
	// 按工作区列表的顺序，读起来与数据面板一致；列表外的（已被移除）放最后。
	seen := map[string]bool{}
	appendGroup := func(workspaceID string) {
		sessions := byWorkspace[workspaceID]
		if len(sessions) == 0 {
			return
		}
		seen[workspaceID] = true
		out = append(out, sessionGroup{label: "📁 " + a.workspaceName(workspaceID), sessions: sessions})
	}
	for i := range a.ws.list {
		appendGroup(a.ws.list[i].WorkspaceID)
	}
	for workspaceID := range byWorkspace {
		if !seen[workspaceID] {
			appendGroup(workspaceID)
		}
	}
	return out
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
