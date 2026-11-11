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
	// open 记着每个目录的展开状态（键是相对工作区根的路径），指针交给 TreeItem 直接读写。
	open map[string]*bool
	// busy 是正在登记成工作区的子目录路径；非空时面板头部转圈，防止重复点击。
	busy string
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

func (a *app) treeOpenAt(path string) *bool {
	if a.ft.open == nil {
		a.ft.open = map[string]*bool{}
	}
	open, ok := a.ft.open[path]
	if !ok {
		open = new(bool)
		a.ft.open[path] = open
	}
	return open
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
	for path, open := range a.ft.open {
		if *open {
			paths = append(paths, path)
		}
	}
	a.ft.dirs = nil
	for _, path := range paths {
		a.loadTreeDir(path)
	}
}

// fileTreeView 画文件树：头部（标题、刷新）、一句提示，以及树本身。
func (a *app) fileTreeView(c *ui.Context, t *ui.Theme, current *service.Workspace) {
	if a.ft.workspaceID != current.WorkspaceID {
		a.ft = fileTree{workspaceID: current.WorkspaceID}
	}
	root := a.treeDirAt("")
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.FolderOpen).TextColor(t.TextMuted)
			ui.Text(c, a.tr("ws.treeTitle")).Bold().FontSize(a.fs(textSection)).Grow(1).MinWidth(0)
			if a.ft.busy != "" {
				ui.Spinner(c)
			}
			if iconButton(c, icons.Refresh, a.tr("ws.treeRefresh")).Clicked() {
				a.reloadTree()
			}
		})
		if a.ft.busy != "" {
			ui.Text(c, a.tr("ws.opening", "name", filepath.Base(a.ft.busy))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		} else {
			ui.Text(c, a.tr("ws.treeHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		ui.Tree(c, func() {
			a.treeLevel(c, t, "")
		}).Label(a.tr("ws.treeTitle"))
		if root.err != "" {
			ui.Text(c, a.tr("ws.treeFailed", "error", root.err)).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
	})
}

// treeLevel 画一个目录的这一层；还没取过就先取（只有展开了的目录才会被画到这里）。
func (a *app) treeLevel(c *ui.Context, t *ui.Theme, path string) {
	d := a.treeDirAt(path)
	if !d.loaded && !d.loading && d.err == "" {
		a.loadTreeDir(path)
	}
	switch {
	case d.err != "" && path != "":
		ui.TreeItem(c, a.tr("ws.treeFailed", "error", d.err), nil, nil).TextColor(t.Danger)
	case !d.loaded && path != "":
		ui.TreeItem(c, a.tr("ws.treeLoading"), nil, nil).TextColor(t.TextMuted)
	}
	for _, e := range d.entries {
		e := e
		label := e.Name
		if e.Kind == "dir" && e.Empty {
			label += "  ·  " + a.tr("ws.treeEmpty")
		}
		var item ui.Element
		if e.Kind == "dir" {
			item = ui.TreeItem(c, label, a.treeOpenAt(e.Path), func() { a.treeLevel(c, t, e.Path) })
		} else {
			item = ui.TreeItem(c, label, nil, nil)
		}
		if e.Ignored {
			item.TextColor(t.TextMuted)
		}
		// 点名字也展开或折叠（TreeItem 自己只认箭头）：用户点的是文件夹，不是那个小三角。
		if e.Kind == "dir" && item.Clicked() {
			open := a.treeOpenAt(e.Path)
			*open = !*open
		}
		item.PopoverMenu(func(m *ui.Menu) {
			if e.Kind == "dir" && m.Item(a.tr("ws.chatHere")).Disabled(a.ft.busy != "").Chosen() {
				a.openWorkspaceChat(e.Path)
			}
			if m.Item(a.tr("ws.reference")).Chosen() {
				a.referencePath(e.Path)
			}
		})
	}
	if d.truncated {
		ui.TreeItem(c, a.tr("ws.treeMore", "count", strconv.Itoa(d.total-len(d.entries))), nil, nil).TextColor(t.TextMuted)
	}
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
