package app

// 工作区文件树（参照 Tern 的文件面板）：数据面板里工作区对话的「Workspace」页签下方，一层一层懒加载。
// 目录右键：在这个子目录里开始一段新对话——把它登记成工作区，然后切到一个归属已选好的空白对话；
// 文件与目录右键都可以把相对路径插进输入框。面板只读，不提供删除、重命名：改用户文件只由 agent 的
// `workspace_*` 工具完成，并受对话的权限模式约束。

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"

	"github.com/egoist/mygo/ui"
)

// treeDir 是一个目录的一层内容与加载状态。
type treeDir struct {
	entries   []service.TreeEntry
	loaded    bool
	loading   bool
	err       string
	truncated bool
	total     int
}

// fileTree 是当前工作区的树状态；工作区一变就整体丢掉重来。
type fileTree struct {
	workspaceID string
	dirs        map[string]*treeDir
	// outline 是 MyGo 的树组件状态：展开的目录（Open）、行与键盘导航都在里面，行内容自己画。
	outline ui.OutlineState[string]
	// entries 是当前已知的条目索引（路径 → 条目），来自已加载的每一层，供树的行使用。
	entries map[string]service.TreeEntry
	// busy 是正在登记成工作区的子目录路径；非空时面板头部转圈，防止重复点击。
	busy string
	// tab 是 Files（0）与 Changes（1）两个页签；pending 是 Changes 的列表，importing 非空时按钮转圈。
	tab        int
	pending    []service.PendingFile
	pendingErr string
	pendingCut bool
	importing  []string
}

func (a *app) treeDirAt(path string) *treeDir {
	if a.ft.dirs == nil {
		a.ft.dirs = map[string]*treeDir{}
	}
	d, ok := a.ft.dirs[path]
	if !ok {
		d = &treeDir{}
		a.ft.dirs[path] = d
	}
	return d
}

// loadTreeDir 取一个目录的这一层；已经在取或取过的不重复请求。
func (a *app) loadTreeDir(path string) {
	client, workspaceID := a.client, a.ft.workspaceID
	d := a.treeDirAt(path)
	if client == nil || workspaceID == "" || d.loading {
		return
	}
	d.loading, d.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		listing, err := client.WorkspaceTree(ctx, workspaceID, path)
		a.post(func() {
			if client != a.client || workspaceID != a.ft.workspaceID {
				return // 服务重启了，或者已经换了工作区
			}
			d := a.treeDirAt(path)
			d.loading = false
			if err != nil {
				d.err = a.sourceErr(err)
				return
			}
			d.entries, d.loaded, d.truncated, d.total = listing.Entries, true, listing.Truncated, listing.Total
		})
	}()
}

// reloadTree 丢掉已取的内容并重新取根和所有展开着的目录（磁盘上的文件变了之后点刷新）。
func (a *app) reloadTree() {
	paths := []string{""}
	for path := range a.ft.outline.Open.All() {
		paths = append(paths, path)
	}
	// 展开状态留在 outline 里；只丢掉取回的内容，重新取一遍。
	a.ft.dirs = nil
	for _, path := range paths {
		a.loadTreeDir(path)
	}
}

// fileTreeView 画文件树：页签、提示，以及 MyGo 的树组件（只建可见行，大目录也不卡）。
func (a *app) fileTreeView(c *ui.Context, t *ui.Theme, current *service.Workspace) {
	if a.ft.workspaceID != current.WorkspaceID {
		a.ft = fileTree{workspaceID: current.WorkspaceID}
	}
	root := a.treeDirAt("")
	// 已加载的每一层合成一个索引：树的行只拿得到路径，图标与徽标从这里查。
	a.ft.entries = make(map[string]service.TreeEntry)
	for _, dir := range a.ft.dirs {
		for _, entry := range dir.entries {
			a.ft.entries[entry.Path] = entry
		}
	}
	ui.Column(c).Gap(6).Children(func() {
		// 工作区名与路径在页签上面的卡片里，这里只放页签与刷新，别再重复一遍。
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if ui.Segmented(c, &a.ft.tab, a.tr("ws.tabFiles"), a.tr("ws.tabChanges")).Label(a.tr("ws.treeTitle")).Shrink(0).Changed() && a.ft.tab == 1 {
				a.loadPending()
			}
			if a.ft.busy != "" || len(a.ft.importing) > 0 {
				ui.Spinner(c)
			}
			ui.Spacer(c)
			if iconButton(c, icons.Refresh, a.tr("ws.treeRefresh")).Clicked() {
				a.reloadTree()
				a.loadPending()
			}
		})
		if a.ft.tab == 1 {
			a.changesView(c, t)
			return
		}
		if a.ft.busy != "" {
			ui.Text(c, a.tr("ws.opening", "name", filepath.Base(a.ft.busy))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		} else {
			ui.Text(c, a.tr("ws.treeHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		if root.err != "" {
			ui.Text(c, a.tr("ws.treeFailed", "error", root.err)).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		} else {
			if !root.loaded && root.loading {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Spinner(c)
					ui.Text(c, a.tr("ws.treeLoading")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				})
			}
			ui.Outline(c, &a.ft.outline, a.rootPaths(), a.childPaths, func(path string) {
				a.treeRow(c, t, path)
			}).Grow(1).MinWidth(0).Label(a.tr("ws.treeTitle"))
			// 一层最多取 500 项：被截掉的部分要说明，否则看起来像文件丢了。
			if root.loaded && root.truncated {
				ui.Text(c, a.tr("ws.treeMore", "count", strconv.Itoa(root.total-len(root.entries)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			}
		}
	})
}

// rootPaths 是树的第一层；还没取到就先取，这一帧画空列表。
func (a *app) rootPaths() []string {
	d := a.treeDirAt("")
	if !d.loaded {
		a.loadTreeDir("")
		return []string{}
	}
	paths := make([]string, 0, len(d.entries))
	for _, entry := range d.entries {
		paths = append(paths, entry.Path)
	}
	return paths
}

// childPaths 是树组件问「这一项的子项」：目录才有；没取过就顺手发起请求，这一帧先当成空的。
func (a *app) childPaths(path string) []string {
	entry, ok := a.ft.entries[path]
	if !ok || entry.Kind != "dir" || entry.Empty {
		return nil
	}
	d := a.treeDirAt(path)
	if !d.loaded {
		a.loadTreeDir(path)
		return []string{}
	}
	paths := make([]string, 0, len(d.entries))
	for _, child := range d.entries {
		paths = append(paths, child.Path)
	}
	return paths
}

// treeRow 画树里的一行：箭头与缩进由 ui.Outline 给，这里画图标、名字与导入状态；点目录展开或折叠。
func (a *app) treeRow(c *ui.Context, t *ui.Theme, path string) {
	entry, ok := a.ft.entries[path]
	if !ok {
		return
	}
	nameColor := t.Text
	row := ui.ButtonBase(c).Label(entry.Name).Grow(1).MinWidth(0).Gap(6).Padding(4, 6).Radius(6).Justify(ui.Start)
	if entry.Ignored {
		row = row.Opacity(0.6)
		nameColor = t.TextMuted
	}
	row.Children(func() {
		icon := icons.File
		color := t.TextMuted
		if entry.Kind == "dir" {
			icon, color = icons.FolderOpen, t.Accent
		}
		ui.Icon(c, icon).TextColor(color).Shrink(0)
		ui.Text(c, entry.Name).SingleLine().TextColor(nameColor)
		if entry.Kind == "dir" && entry.Empty {
			ui.Text(c, a.tr("ws.treeEmpty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
		}
		// 导入状态：目录里还有待导入的（●），文件没导入过（?）、导入后变了（!）、已导入（表格图标）。
		switch {
		case entry.Kind == "dir" && entry.Pending > 0:
			ui.Text(c, "●").FontSize(a.fs(textCaption)).TextColor(t.Accent).Shrink(0).Tooltip(a.tr("ws.pendingIn", "count", strconv.Itoa(entry.Pending)))
		case entry.Kind == "file" && entry.Data && entry.ImportState == "new":
			ui.Text(c, "?").FontSize(a.fs(textCaption)).TextColor(t.Warning).Shrink(0).Tooltip(a.tr("ws.importNeeded"))
		case entry.Kind == "file" && entry.Data && entry.ImportState == "changed":
			ui.Text(c, "!").FontSize(a.fs(textCaption)).TextColor(t.Warning).Shrink(0).Tooltip(a.tr("ws.importChanged"))
		case entry.Kind == "file" && entry.Data && entry.ImportState == "imported":
			ui.Icon(c, icons.Table).TextColor(t.TextMuted).Shrink(0).Tooltip(a.tr("ws.imported"))
		}
		if entry.Kind == "dir" && !entry.Empty {
			// 点目录名也能展开：箭头太小，用户点的是名字。展开状态由树组件持有。
			if row.Clicked() {
				if a.ft.outline.Open.Has(path) {
					a.ft.outline.Open.Remove(path)
				} else {
					a.ft.outline.Open.Add(path)
				}
			}
		}
	})
	row.PopoverMenu(func(m *ui.Menu) {
		if entry.Kind == "dir" && m.Item(a.tr("ws.chatHere")).Disabled(a.ft.busy != "").Chosen() {
			a.openWorkspaceChat(entry.Path)
		}
		if entry.Kind == "file" && entry.Data && entry.ImportState != "imported" {
			if m.Item(a.tr("ws.import")).Disabled(len(a.ft.importing) > 0).Chosen() {
				a.importFiles([]string{entry.Path})
			}
		}
		if m.Item(a.tr("ws.reference")).Chosen() {
			a.referencePath(entry.Path)
		}
	})
}

// loadPending 取「Changes」页签的列表；导入或刷新后调用。
func (a *app) loadPending() {
	client, workspaceID := a.client, a.ft.workspaceID
	if client == nil || workspaceID == "" {
		return
	}
	a.ft.pendingErr = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		files, truncated, err := client.WorkspacePending(ctx, workspaceID)
		a.post(func() {
			if client != a.client || workspaceID != a.ft.workspaceID {
				return
			}
			if err != nil {
				a.ft.pendingErr = a.sourceErr(err)
				return
			}
			a.ft.pending, a.ft.pendingCut = files, truncated
		})
	}()
}

// importFiles 导入指定的数据文件；导入在服务端走共享来源，完成后刷新树、Changes 与数据源列表。
func (a *app) importFiles(paths []string) {
	client, workspaceID, current := a.client, a.ft.workspaceID, a.src.current
	if client == nil || workspaceID == "" || current == nil || len(paths) == 0 || len(a.ft.importing) > 0 {
		return
	}
	a.ft.importing, a.src.notice, a.src.noticeErr = paths, "", false
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		out, err := client.ImportWorkspaceFiles(ctx, workspaceID, paths)
		a.post(func() {
			if client != a.client || workspaceID != a.ft.workspaceID {
				return
			}
			a.ft.importing = nil
			if err != nil {
				a.src.notice, a.src.noticeErr = a.tr("ws.importFailed", "error", a.sourceErr(err)), true
				return
			}
			label := paths[0]
			if len(paths) > 1 {
				label = a.tr("ws.importedMany", "count", strconv.Itoa(len(paths)))
			}
			if len(out.Errors) > 0 {
				a.src.notice, a.src.noticeErr = a.tr("ws.importedSkipped", "label", label, "errors", strings.Join(out.Errors, "; ")), true
			} else {
				a.src.notice, a.src.noticeErr = a.tr("ws.imported", "label", label), false
			}
			a.reloadTree()
			a.loadPending()
			a.loadSources()
		})
	}()
}

// changesView 是「Changes」页签：列表 + 一键全部导入。
func (a *app) changesView(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(4).Children(func() {
		if len(a.ft.importing) > 0 {
			ui.Text(c, a.tr("ws.importing", "count", strconv.Itoa(len(a.ft.importing)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		} else if len(a.ft.pending) == 0 {
			ui.Text(c, a.tr("ws.changesEmpty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		} else {
			paths := make([]string, 0, len(a.ft.pending))
			for _, file := range a.ft.pending {
				paths = append(paths, file.Path)
			}
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, a.tr("ws.changesCount", "count", strconv.Itoa(len(a.ft.pending)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Grow(1).MinWidth(0)
				if ui.PrimaryButton(c, a.tr("ws.importAll")).Shrink(0).Clicked() {
					a.importFiles(paths)
				}
			})
			for _, file := range a.ft.pending {
				file := file
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					badge := "?"
					tip := a.tr("ws.importNeeded")
					if file.State == "changed" {
						badge, tip = "!", a.tr("ws.importChanged")
					}
					ui.Text(c, badge).FontSize(a.fs(textCaption)).TextColor(t.Warning).Shrink(0).Tooltip(tip)
					ui.Text(c, file.Path).SingleLine().Grow(1).MinWidth(0).Tooltip(file.Path)
					if ui.Button(c, a.tr("ws.import")).FontSize(a.fs(textCaption)).Shrink(0).Disabled(len(a.ft.importing) > 0).Clicked() {
						a.importFiles([]string{file.Path})
					}
				})
			}
			if a.ft.pendingCut {
				ui.Text(c, a.tr("ws.changesCut")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			}
		}
		if a.ft.pendingErr != "" {
			ui.Text(c, a.tr("ws.treeFailed", "error", a.ft.pendingErr)).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
	})
}

// referencePath 把相对路径接到输入框末尾（路径里有空格时加引号），并让输入框取得焦点。
func (a *app) referencePath(path string) {
	if strings.ContainsAny(path, " \t") {
		path = `"` + path + `"`
	}
	if a.input != "" && !strings.HasSuffix(a.input, " ") && !strings.HasSuffix(a.input, "\n") {
		a.input += " "
	}
	a.input += path
	a.cv.wantFocus = true
}

// openWorkspaceChat 在工作区的一个子目录里开始新对话：把它登记成工作区（同一目录幂等，已有就直接复用），
// 然后切到空白新对话、归属选好；真正的对话在发出第一条消息时才创建，所以不会留下空对话。
func (a *app) openWorkspaceChat(rel string) {
	client, current := a.client, a.src.current
	if client == nil || current == nil || a.ft.busy != "" {
		return
	}
	path := filepath.Join(current.Workdir, filepath.FromSlash(rel))
	a.ft.busy, a.src.workspaceErr = rel, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		out, err := client.CreateWorkspace(ctx, path, "", "")
		a.post(func() {
			if client != a.client {
				return
			}
			a.ft.busy = ""
			if err != nil {
				a.src.workspaceErr = a.sourceErr(err)
				return
			}
			if out.Workspace == nil {
				return
			}
			// 新工作区先进索引，setNewScope 才认得它（列表刷新是另一次往返）。
			if a.workspaceByID(out.Workspace.WorkspaceID) == nil {
				a.ws.list = append(a.ws.list, *out.Workspace)
			}
			a.setNewScope(out.Workspace.WorkspaceID)
			a.newChat()
			a.cv.wantFocus = true
			a.loadWorkspaces()
			if len(out.Errors) > 0 {
				a.src.notice, a.src.noticeErr = a.tr("data.mountedSkipped", "label", out.Workspace.Name, "skipped", strings.Join(out.Errors, "; ")), true
			}
		})
	}()
}
