package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"datawhisper/desktop/internal/api"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// 数据面板（P7.3）：会话的数据来源、工作区与产物。它作为聊天页右侧的 Split 出现，数据按会话加载：
// 来源、工作区、产物都是会话级的，跟着聊天切换比另开一页更自然，也省下侧边栏的导航层。所有写操作成功后
// 都重新拉列表并刷新正在看的预览，用户不需要手动刷新。

// 数据面板的页签。
const (
	sourcesTabSources = iota
	sourcesTabWorkspace
	sourcesTabArtifacts
)

// 确认对话框要删的东西。
const (
	confirmSource    = "source"
	confirmSourceAll = "sources-all"
	confirmWorkspace = "workspace"
)

// 工作区权限的两个标签，顺序与 permissionValueForLabel 一致。
var workspacePermissionLabels = []string{"Read only", "Read & write"}

// remoteKind 是一个远程来源类型：id 与服务端一致，label 是下拉框里的写法。
type remoteKind struct {
	ID    string
	Label string
}

var remoteKinds = []remoteKind{
	{ID: "sql", Label: "SQL database"},
	{ID: "gsheets", Label: "Google Sheets"},
	{ID: "feishu", Label: "Feishu Bitable"},
	{ID: "http", Label: "HTTP API"},
}

// uploadLimitUnknown 在还没向服务端开过票时显示。
const uploadLimitUnknown = "The service sets the limit when the import starts."

// sourcesState 是数据面板的数据与编辑状态。只有 UI 线程会改它：构建视图时，以及在 post 上排队的函数里。
type sourcesState struct {
	open  bool    // 面板是否展开
	split float32 // 面板占聊天区宽度的百分比（ui.SplitPercent）

	gen     int // 丢弃旧加载的结果
	conv    int // 这份数据属于哪个会话
	loading bool
	loaded  bool
	err     string
	tab     int

	sources []api.Source

	// 预览：previewID 是正在看的来源，previewTable 是选中的表。
	previewID      string
	preview        *api.SourcePreview
	previewErr     string
	previewTable   string
	table          *api.PreviewTable
	tableErr       string
	schema         string
	schemaErr      string
	previewLoading bool

	// 上传：maxBytes 是服务端最近一次声明的上限，0 表示还不知道。
	maxBytes       int64
	uploading      bool
	uploadName     string
	uploadProgress float64
	uploadErr      string

	// 远程连接表单。密钥只存在于输入框里，连接成功后立刻清空。
	remoteOpen     bool
	remoteKind     int
	remoteName     string
	remoteSpread   string // gsheets: spreadsheet
	remoteBitable  string // feishu: bitable
	remoteTable    string // feishu: table
	remoteURL      string // http: url
	remoteAuth     int    // http: auth_type（0 none / 1 bearer / 2 api_key）
	remoteConn     string // sql: connection_string
	remoteCreds    string // gsheets: creds_json
	remoteAuthVal  string // http: auth_value
	remoteConfigID string // 已保存配置的 id，空表示新建
	remoteErr      string
	remoteBusy     bool
	configs        []api.SourceConfig
	configsErr     string

	// 工作区。
	current      *api.Workspace
	workspaces   []api.Workspace
	workspaceErr string
	mountPath    string
	mountName    string
	mountPerm    int // 0 read_only / 1 read_write
	mountBusy    bool
	mountErr     string
	permBusy     string // 正在改权限的 workspaceId

	// 产物。
	artifacts      []api.Artifact
	artifactsErr   string
	artifactText   string
	artifactName   string
	artifactErr    string
	artifactLoaded bool

	// 确认对话框与编辑对话框。
	confirmOpen bool
	confirmKind string
	confirmID   string
	confirmName string

	editOpen   bool
	editID     string
	editTables []string
	editPicked map[string]bool
	editErr    string
	editBusy   bool

	notice    string
	noticeErr bool

	monoOnce bool
	mono     string
}

// monoFont 给 schema 与产物文本挑一个等宽字体；找不到时退回主题的默认字体。
func (a *app) monoFont() string {
	if !a.src.monoOnce {
		a.src.monoOnce = true
		for _, f := range ui.FontFamilies() {
			if f.Monospaced {
				a.src.mono = f.Name
				break
			}
		}
	}
	return a.src.mono
}

// sourcesConversationChanged 在聊天切换到另一个会话时丢掉上一份数据，面板展开时立刻重新加载。
func (a *app) sourcesConversationChanged() {
	a.src.gen++
	a.src.conv, a.src.loaded, a.src.loading = a.conv, false, false
	a.src.err = ""
	a.src.sources = nil
	a.src.previewID, a.src.preview, a.src.previewTable, a.src.table = "", nil, "", nil
	a.src.schema, a.src.previewErr, a.src.tableErr, a.src.schemaErr = "", "", "", ""
	a.src.current, a.src.workspaces = nil, nil
	a.src.artifacts, a.src.artifactsErr = nil, ""
	a.src.artifactName, a.src.artifactText, a.src.artifactErr = "", "", ""
	a.src.confirmOpen, a.src.editOpen = false, false
	if a.src.open {
		a.loadSources()
	}
}

// toggleSources 展开或收起数据面板；展开时加载当前会话的数据。
func (a *app) toggleSources() {
	a.src.open = !a.src.open
	if a.src.open {
		if a.src.split == 0 {
			a.src.split = 38
		}
		a.loadSources()
	}
}

// loadSources 拉取当前会话的来源、工作区、产物与已保存的连接配置。一次请求把它们一起取回，避免面板在
// 多次往返之间显示不一致的中间状态。
func (a *app) loadSources() {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		a.src.loading, a.src.loaded, a.src.err = false, true, ""
		return
	}
	a.src.conv = conv
	a.src.gen++
	gen := a.src.gen
	a.src.loading, a.src.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		sources, sourcesErr := client.Sources(ctx, conv)
		view, workspaceErr := client.Workspaces(ctx, conv)
		artifacts, artifactsErr := client.Artifacts(ctx, conv, "", 0)
		configs, configsErr := client.SourceConfigs(ctx)
		a.post(func() {
			if client != a.client || gen != a.src.gen || a.src.conv != conv {
				return
			}
			a.src.loading, a.src.loaded = false, true
			switch {
			case sourcesErr != nil:
				a.src.err = sourceErrorText(sourcesErr)
			default:
				a.src.sources, a.src.err = sources, ""
			}
			if workspaceErr != nil {
				a.src.workspaceErr = sourceErrorText(workspaceErr)
			} else {
				a.src.current = view.Workspace
				a.src.workspaces = view.Workspaces
				a.src.workspaceErr = ""
			}
			if artifactsErr != nil {
				a.src.artifactsErr = sourceErrorText(artifactsErr)
			} else {
				a.src.artifacts, a.src.artifactsErr = artifacts, ""
			}
			if configsErr != nil {
				a.src.configsErr = sourceErrorText(configsErr)
			} else {
				a.src.configs, a.src.configsErr = configs, ""
			}
			// 正在看的来源被删掉时，把预览一起收起来。
			if a.src.previewID != "" && !hasSource(a.src.sources, a.src.previewID) {
				a.src.previewID, a.src.preview, a.src.table = "", nil, nil
				a.src.previewTable, a.src.schema = "", ""
			}
			if a.src.previewID != "" {
				a.refreshPreview(a.src.previewID, a.src.previewTable, false)
			}
		})
	}()
}

func hasSource(sources []api.Source, id string) bool {
	for _, s := range sources {
		if s.ID == id {
			return true
		}
	}
	return false
}

// refreshPreview 重新读取一个来源的表元信息，并（keep 为 false 时）重新加载选中的表与其 schema。
func (a *app) refreshPreview(sourceID, table string, keep bool) {
	client, conv := a.client, a.src.conv
	if client == nil || conv == 0 || sourceID == "" {
		return
	}
	a.src.previewLoading, a.src.previewErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		preview, err := client.PreviewSource(ctx, conv, sourceID)
		schema, schemaErr := client.SourceSchema(ctx, conv, sourceID)
		var rows api.PreviewTable
		var rowsErr error
		chosen := table
		if err == nil {
			if chosen == "" || !hasPreviewTable(preview.Tables, chosen) {
				chosen = firstTable(preview.Tables)
			}
			if chosen != "" {
				rows, rowsErr = client.PreviewTable(ctx, conv, sourceID, chosen)
			}
		}
		a.post(func() {
			if client != a.client || a.src.conv != conv || a.src.previewID != sourceID {
				return
			}
			a.src.previewLoading = false
			if err != nil {
				a.src.previewErr = "Could not read the tables: " + sourceErrorText(err)
				return
			}
			a.src.preview = &preview
			a.src.previewTable = chosen
			if schemaErr != nil {
				a.src.schema, a.src.schemaErr = "", sourceErrorText(schemaErr)
			} else {
				a.src.schema, a.src.schemaErr = schema, ""
			}
			if chosen == "" {
				a.src.table, a.src.tableErr = nil, ""
				return
			}
			if rowsErr != nil {
				a.src.table, a.src.tableErr = nil, sourceErrorText(rowsErr)
				return
			}
			a.src.table, a.src.tableErr = &rows, ""
		})
	}()
}

func hasPreviewTable(tables []api.PreviewTableInfo, name string) bool {
	for _, t := range tables {
		if t.Name == name {
			return true
		}
	}
	return false
}

func firstTable(tables []api.PreviewTableInfo) string {
	if len(tables) == 0 {
		return ""
	}
	return tables[0].Name
}

// showPreview 选中一个来源并加载它的第一张表。
func (a *app) showPreview(sourceID string) {
	a.src.previewID = sourceID
	a.src.preview, a.src.previewTable, a.src.table = nil, "", nil
	a.src.schema, a.src.previewErr, a.src.tableErr, a.src.schemaErr = "", "", "", ""
	a.refreshPreview(sourceID, "", false)
}

// pickFile 打开系统的选文件对话框；选中的文件交给 uploadFile。
func (a *app) pickFile() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Title:   "Import a data file",
			Message: "CSV, Excel or PDF",
			Filters: []mygo.FileFilter{{Name: "Data files", Extensions: []string{"csv", "xlsx", "xls", "pdf"}}},
		})
		if err != nil {
			a.post(func() { a.src.uploadErr = "The file dialog is unavailable: " + err.Error() })
			return
		}
		if len(paths) == 0 {
			return // 用户取消
		}
		path := paths[0]
		a.post(func() { a.uploadFile(path) })
	}()
}

// uploadFile 三段式导入：开票（说清大小）→ 写字节到服务端给的路径 → source.open。超过服务端上限的文件在
// 写盘之前就被拒绝；写失败时删掉半成品，不调 open。
func (a *app) uploadFile(path string) {
	client, conv := a.client, a.src.conv
	if client == nil || conv == 0 {
		a.src.uploadErr = "Open a chat before importing a file."
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		a.src.uploadErr = "Could not read " + path + ": " + err.Error()
		return
	}
	if info.IsDir() {
		a.src.uploadErr = path + " is a folder, not a data file."
		return
	}
	filename := filepath.Base(path)
	if info.Size() <= 0 {
		a.src.uploadErr = filename + " is empty."
		return
	}
	if a.src.maxBytes > 0 && info.Size() > a.src.maxBytes {
		a.src.uploadErr = oversizeText(filename, info.Size(), a.src.maxBytes)
		return
	}
	a.src.uploading, a.src.uploadErr = true, ""
	a.src.uploadName, a.src.uploadProgress = filename, 0
	size := info.Size()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		ticket, err := client.BeginUpload(ctx, conv, filename, size)
		if err != nil {
			a.post(func() {
				if client != a.client {
					return
				}
				a.src.uploading = false
				a.src.uploadErr = sourceErrorText(err)
			})
			return
		}
		a.post(func() { a.src.maxBytes = ticket.MaxBytes })
		// 服务端声明的上限比本地文件小：现在拒绝，票据自然过期，绝不先写盘。
		if ticket.MaxBytes > 0 && size > ticket.MaxBytes {
			a.post(func() {
				if client != a.client {
					return
				}
				a.src.uploading = false
				a.src.uploadErr = oversizeText(filename, size, ticket.MaxBytes)
			})
			return
		}
		var last time.Time
		err = copyFile(path, ticket.Path, func(done int64) {
			// 进度最多每 80 毫秒推一次，避免把 UI 线程灌满。
			if now := time.Now(); now.Sub(last) < 80*time.Millisecond && done < size {
				return
			} else {
				last = now
			}
			ratio := float64(done) / float64(size)
			a.post(func() {
				if client == a.client {
					a.src.uploadProgress = ratio
				}
			})
		})
		if err != nil {
			_ = os.Remove(ticket.Path)
			a.post(func() {
				if client != a.client {
					return
				}
				a.src.uploading = false
				a.src.uploadErr = "Could not copy " + filename + ": " + err.Error()
			})
			return
		}
		opened, err := client.OpenUpload(ctx, conv, ticket.UploadID, "")
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.uploading = false
			if err != nil {
				a.src.uploadErr = sourceErrorText(err)
				return
			}
			name := filename
			if opened.Source != nil && opened.Source.Name != "" {
				name = opened.Source.Name
			}
			a.src.notice, a.src.noticeErr = "Imported "+name+".", false
			a.loadSources()
		})
	}()
}

// copyFile 把 src 的字节写到 dst（必须是新文件，0600），每写完一段报告累计字节数。
func copyFile(src, dst string, progress func(done int64)) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	buf := make([]byte, 256<<10)
	var done int64
	for {
		n, readErr := in.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				_ = out.Close()
				return writeErr
			}
			done += int64(n)
			if progress != nil {
				progress(done)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = out.Close()
			return readErr
		}
	}
	return out.Close()
}

// oversizeText 说明文件超限：本地大小、服务端上限都说清楚。
func oversizeText(name string, size, limit int64) string {
	return fmt.Sprintf("%s is %s; the service accepts at most %s.", name, formatBytes(size), formatBytes(limit))
}

// formatBytes 用 IEC 单位显示字节数。
func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value := float64(n)
	for _, suffix := range []string{"KiB", "MiB", "GiB", "TiB"} {
		value /= unit
		if value < unit {
			return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.1f", value), "0"), ".") + " " + suffix
		}
	}
	return fmt.Sprintf("%.0f PiB", value/unit)
}

// setSourceActive 打开/关闭一个来源的「参与分析」。
func (a *app) setSourceActive(src api.Source, on bool) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := client.ToggleSource(ctx, conv, src.ID, &on)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not change "+src.Name+": "+sourceErrorText(err), true
				return
			}
			word := "excluded from"
			if out.Active {
				word = "included in"
			}
			a.src.notice, a.src.noticeErr = src.Name+" is now "+word+" analysis.", false
			a.loadSources()
		})
	}()
}

// openSources 重新打开一个已关闭的来源。
func (a *app) openSource(src api.Source) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err := client.ReopenSource(ctx, conv, src.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not open "+src.Name+": "+sourceErrorText(err), true
				return
			}
			a.src.notice, a.src.noticeErr = src.Name+" is open.", false
			a.loadSources()
		})
	}()
}

// closeSource 在计算侧关闭一个来源。
func (a *app) closeSource(src api.Source) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, err := client.CloseSource(ctx, conv, src.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not close "+src.Name+": "+sourceErrorText(err), true
				return
			}
			a.src.notice, a.src.noticeErr = src.Name+" is closed.", false
			a.loadSources()
		})
	}()
}

// removeSource 删除一个来源的记录。
func (a *app) removeSource(src api.Source) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.RemoveSource(ctx, conv, src.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not remove "+src.Name+": "+sourceErrorText(err), true
				return
			}
			if a.src.previewID == src.ID {
				a.src.previewID, a.src.preview, a.src.table = "", nil, nil
				a.src.previewTable, a.src.schema = "", ""
			}
			a.src.notice, a.src.noticeErr = src.Name+" removed.", false
			a.loadSources()
		})
	}()
}

// removeAllSources 断开并清空会话的全部来源。
func (a *app) removeAllSources() {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err := client.RemoveAllSources(ctx, conv)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not remove the sources: "+sourceErrorText(err), true
				return
			}
			a.src.previewID, a.src.preview, a.src.table = "", nil, nil
			a.src.previewTable, a.src.schema = "", ""
			a.src.notice, a.src.noticeErr = "All data sources are removed.", false
			a.loadSources()
		})
	}()
}

// startRemote 打开远程连接表单，serviceKind 是 remoteKinds 的下标。
func (a *app) startRemote(index int) {
	a.src.remoteOpen = true
	a.src.remoteKind = index
	a.src.remoteErr = ""
	a.src.remoteConfigID = ""
	a.src.remoteName, a.src.remoteSpread, a.src.remoteBitable = "", "", ""
	a.src.remoteTable, a.src.remoteURL, a.src.remoteAuth = "", "", 0
	a.src.remoteConn, a.src.remoteCreds, a.src.remoteAuthVal = "", "", ""
}

// useConfig 把一条已保存配置的非密字段填进表单；密字段只提示已保存，绝不回填值。
func (a *app) useConfig(cfg api.SourceConfig) {
	a.src.remoteConfigID = cfg.ID
	a.src.remoteName = cfg.Name
	a.src.remoteSpread = cfg.Fields["spreadsheet"]
	a.src.remoteBitable = cfg.Fields["bitable"]
	a.src.remoteTable = cfg.Fields["table"]
	a.src.remoteURL = cfg.Fields["url"]
	a.src.remoteAuth = 0
	switch cfg.Fields["auth_type"] {
	case "bearer":
		a.src.remoteAuth = 1
	case "api_key":
		a.src.remoteAuth = 2
	}
	// 已保存的凭据不回到界面：输入框留空，占位符说明它已存在。
	a.src.remoteConn, a.src.remoteCreds, a.src.remoteAuthVal = "", "", ""
}

// connectRemote 提交远程连接表单。密钥只随这一次请求离开界面。
func (a *app) connectRemote() {
	client, conv := a.client, a.src.conv
	if client == nil || conv == 0 {
		a.src.remoteErr = "Open a chat before connecting a source."
		return
	}
	kind := remoteKinds[a.src.remoteKind]
	req := api.RemoteRequest{Kind: kind.ID, Name: strings.TrimSpace(a.src.remoteName), ConfigID: a.src.remoteConfigID}
	switch kind.ID {
	case "sql":
		if a.src.remoteConn == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = "Enter the connection string."
			return
		}
		req.Secret = map[string]string{}
		if a.src.remoteConn != "" {
			req.Secret["connection_string"] = a.src.remoteConn
		}
	case "gsheets":
		req.Fields = map[string]string{"spreadsheet": strings.TrimSpace(a.src.remoteSpread)}
		req.Secret = map[string]string{}
		if a.src.remoteCreds != "" {
			req.Secret["creds_json"] = a.src.remoteCreds
		}
		if req.Fields["spreadsheet"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = "Enter the spreadsheet URL or id."
			return
		}
	case "feishu":
		req.Fields = map[string]string{
			"bitable": strings.TrimSpace(a.src.remoteBitable),
			"table":   strings.TrimSpace(a.src.remoteTable),
		}
		if req.Fields["bitable"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = "Enter the Bitable link or app_token."
			return
		}
	case "http":
		authTypes := []string{"none", "bearer", "api_key"}
		req.Fields = map[string]string{"url": strings.TrimSpace(a.src.remoteURL), "auth_type": authTypes[a.src.remoteAuth]}
		req.Secret = map[string]string{}
		if a.src.remoteAuthVal != "" {
			req.Secret["auth_value"] = a.src.remoteAuthVal
		}
		if req.Fields["url"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = "Enter the API URL."
			return
		}
	}
	if len(req.Secret) == 0 {
		req.Secret = nil
	}
	a.src.remoteBusy, a.src.remoteErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		opened, err := client.OpenRemote(ctx, conv, req)
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.remoteBusy = false
			if err != nil {
				a.src.remoteErr = sourceErrorText(err)
				return
			}
			name := kind.Label
			if opened.Source != nil && opened.Source.Name != "" {
				name = opened.Source.Name
			}
			// 密钥只写不读：成功后立刻清空输入框。
			a.src.remoteConn, a.src.remoteCreds, a.src.remoteAuthVal = "", "", ""
			a.src.remoteOpen, a.src.remoteErr = false, ""
			a.src.notice, a.src.noticeErr = "Connected "+name+".", false
			a.loadSources()
		})
	}()
}

// removeConfig 删除一条保存的连接配置。
func (a *app) removeConfig(cfg api.SourceConfig) {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, err := client.RemoveSourceConfig(ctx, cfg.ID)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not remove the saved connection: "+sourceErrorText(err), true
				return
			}
			if a.src.remoteConfigID == cfg.ID {
				a.src.remoteConfigID = ""
			}
			a.src.notice, a.src.noticeErr = "Saved connection removed.", false
			a.loadSources()
		})
	}()
}

// mountWorkspace 把输入的目录挂成工作区。
func (a *app) mountWorkspace() {
	client, conv := a.client, a.src.conv
	path := strings.TrimSpace(a.src.mountPath)
	if client == nil || conv == 0 {
		a.src.mountErr = "Open a chat before mounting a folder."
		return
	}
	if path == "" {
		a.src.mountErr = "Enter the folder to mount."
		return
	}
	if !filepath.IsAbs(path) {
		a.src.mountErr = "Use an absolute path, for example /home/me/data."
		return
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		a.src.mountErr = path + " is not a folder this app can read."
		return
	}
	readOnly := a.src.mountPerm == 0
	name := strings.TrimSpace(a.src.mountName)
	a.src.mountBusy, a.src.mountErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		out, err := client.MountWorkspace(ctx, conv, path, name, readOnly)
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.mountBusy = false
			if err != nil {
				a.src.mountErr = sourceErrorText(err)
				return
			}
			label := path
			if out.Workspace != nil && out.Workspace.Name != "" {
				label = out.Workspace.Name
			}
			a.src.mountPath, a.src.mountName, a.src.mountErr = "", "", ""
			if len(out.Errors) > 0 {
				a.src.notice, a.src.noticeErr = "Mounted "+label+" (skipped: "+strings.Join(out.Errors, "; ")+").", true
			} else {
				a.src.notice, a.src.noticeErr = "Mounted "+label+".", false
			}
			a.loadSources()
		})
	}()
}

// unmountWorkspace 卸载一个工作区。
func (a *app) unmountWorkspace(id string) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err := client.UnmountWorkspace(ctx, conv, id)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not unmount the folder: "+sourceErrorText(err), true
				return
			}
			a.src.notice, a.src.noticeErr = "Folder unmounted.", false
			a.loadSources()
		})
	}()
}

// removeWorkspace 删除一条已卸载的工作区记录（目录本身不动）。
func (a *app) removeWorkspace(id string) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err := client.RemoveWorkspace(ctx, conv, id)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not remove the folder: "+sourceErrorText(err), true
				return
			}
			a.src.notice, a.src.noticeErr = "Folder removed from this chat.", false
			a.loadSources()
		})
	}()
}

// setWorkspacePermission 改一个工作区的读写权限。
func (a *app) setWorkspacePermission(id, permission string) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	a.src.permBusy = id
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, err := client.SetWorkspacePermission(ctx, conv, id, permission)
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.permBusy = ""
			if err != nil {
				a.src.notice, a.src.noticeErr = "Could not change the permission: "+sourceErrorText(err), true
				return
			}
			a.src.notice, a.src.noticeErr = "Permission saved.", false
			a.loadSources()
		})
	}()
}

// openSourceEditor 打开来源编辑对话框：SQL 来源在这里选分析表，所有来源都能在这里开关。
func (a *app) openSourceEditor(src api.Source) {
	a.src.editOpen, a.src.editID, a.src.editErr, a.src.editBusy = true, src.ID, "", false
	a.src.editPicked = map[string]bool{}
	a.src.editTables = append([]string(nil), src.Tables...)
	if len(a.src.editTables) > 0 && a.src.preview != nil && a.src.previewID == src.ID {
		for _, t := range a.src.preview.Tables {
			if t.SelectedForAnalysis {
				a.src.editPicked[t.Name] = true
			}
		}
	}
	if src.Kind != "sql" {
		return
	}
	a.src.editBusy = true
	client, conv := a.client, a.src.conv
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		preview, err := client.PreviewSource(ctx, conv, src.ID)
		a.post(func() {
			if client != a.client || a.src.editID != src.ID {
				return
			}
			a.src.editBusy = false
			if err != nil {
				a.src.editErr = "Could not read the tables: " + sourceErrorText(err)
				return
			}
			a.src.editTables = nil
			for _, t := range preview.Tables {
				a.src.editTables = append(a.src.editTables, t.Name)
				if t.SelectedForAnalysis {
					a.src.editPicked[t.Name] = true
				}
			}
		})
	}()
}

// saveSourceTables 保存分析表选择。
func (a *app) saveSourceTables() {
	client, conv := a.client, a.src.conv
	if client == nil || a.src.editID == "" {
		return
	}
	var picked []string
	for _, name := range a.src.editTables {
		if a.src.editPicked[name] {
			picked = append(picked, name)
		}
	}
	if picked == nil {
		picked = []string{}
	}
	id := a.src.editID
	a.src.editBusy = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err := client.SetAnalysisTables(ctx, conv, id, picked)
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.editBusy = false
			if err != nil {
				a.src.editErr = sourceErrorText(err)
				return
			}
			a.src.editOpen = false
			a.src.notice, a.src.noticeErr = fmt.Sprintf("%d tables are used in analysis.", len(picked)), false
			a.loadSources()
		})
	}()
}

// previewArtifact 读取一个产物的文本；不能内联预览的产物只提示路径。
func (a *app) previewArtifact(art api.Artifact) {
	client, conv := a.client, a.src.conv
	if client == nil {
		return
	}
	a.src.artifactName, a.src.artifactText, a.src.artifactErr = art.Name, "", ""
	a.src.artifactLoaded = false
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		content, err := client.ReadArtifact(ctx, conv, art.Name, "", "text")
		a.post(func() {
			if client != a.client || a.src.artifactName != art.Name {
				return
			}
			a.src.artifactLoaded = true
			if err != nil {
				var e *api.Error
				if errors.As(err, &e) && e.Reason == "file_too_large" {
					// 产物无法内联预览时只说明路径，用户自己在系统里打开。
					a.src.artifactErr = "This artifact is too large to show here: " + art.Path
					return
				}
				a.src.artifactErr = sourceErrorText(err)
				return
			}
			a.src.artifactText = content.Text
		})
	}()
}

// sourceErrorText 把数据源/工作区/产物方法的错误翻成用户能照着做的话；上传被拒的每种 reason 单独说明。
func sourceErrorText(err error) string {
	var e *api.Error
	if errors.As(err, &e) {
		switch e.Reason {
		case "unsupported_format":
			return "Only .csv, .xlsx, .xls and .pdf files can be imported."
		case "empty_file":
			return "The file is empty."
		case "file_too_large":
			return "The file is larger than the service's import limit: " + e.Message
		case "upload_missing":
			return "The upload did not reach the service; import the file again."
		case "upload_not_file":
			return "The upload is not a regular file; import the file again."
		case "upload_outside_root":
			return "The upload left the staging folder; import the file again."
		case "upload_size_mismatch":
			return "The file changed while it was copied; import it again."
		case "unknown_upload", "upload_expired":
			return "The import expired before it finished; import the file again."
		case "invalid_workdir":
			return "That folder cannot be mounted: " + e.Message
		case "not_mounted":
			return "No folder is mounted."
		case "workspace_connected":
			return "Unmount the folder before removing it."
		case "confirmation_required":
			return "Confirm the removal first."
		case "invalid_workspace_name":
			return e.Message
		case "not_sql_source":
			return "Only a SQL source chooses its analysis tables."
		case "invalid_credentials":
			return "The service account JSON is not valid."
		case "missing_connection_string":
			return "Enter the connection string."
		case "missing_spreadsheet":
			return "Enter the spreadsheet URL or id."
		case "missing_bitable":
			return "Enter the Bitable link or app_token."
		case "missing_table":
			return "Enter the table id."
		case "invalid_bitable":
			return "The Bitable link or table id is not valid."
		case "missing_url":
			return "Enter the API URL."
		case "invalid_url":
			return "The API URL must be an http(s) URL."
		case "invalid_auth_type":
			return "Choose no auth, a bearer token, or an API key."
		case "missing_auth_value":
			return "Enter the token or API key."
		case "config_kind_mismatch":
			return "That saved connection belongs to another source type."
		case "invalid_descriptor":
			return "The folder produced no usable data source."
		case "preview_failed":
			return "The service could not preview this table: " + e.Message
		case "invalid_artifact_name":
			return "That artifact name is not valid."
		}
		if e.Kind == "not_found" {
			return "The service could not find it anymore: " + e.Message
		}
		switch e.Code {
		case -32601:
			return "This service build has no data-source support (method not found)."
		case -32602:
			return "The service rejected the request: " + e.Message
		case -32000:
			return "The service could not do that: " + e.Message
		case -32603:
			return "The service failed while doing that: " + e.Message
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

// sourcesPanel 构建右侧的数据面板。
func (a *app) sourcesPanel(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).Background(t.Background).BorderWidth(0, 0, 0, 1).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(10, 16).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, "Data").Bold().FontSize(16)
			if a.src.conv != 0 {
				ui.Textf(c, "Chat %d", a.src.conv).FontSize(12).TextColor(t.TextMuted)
			}
			ui.Spacer(c)
			if a.client != nil && ui.Button(c, "Refresh").Tooltip("Reload the sources, workspace and artifacts").Clicked() {
				a.loadSources()
			}
			if ui.Button(c, "Hide").Tooltip("Hide the data panel").Clicked() {
				a.src.open = false
			}
		})
		if a.client == nil {
			ui.Text(c, "Data sources are available once the agent service is ready.").TextColor(t.TextMuted).Padding(16)
			return
		}
		if a.src.conv == 0 {
			ui.Text(c, "Start a chat to add data sources.").TextColor(t.TextMuted).Padding(16)
			return
		}
		a.showSourceNotice(c)
		if a.src.loading && !a.src.loaded {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(16).Children(func() {
				ui.Spinner(c)
				ui.Text(c, "Loading the data sources…").TextColor(t.TextMuted)
			})
			return
		}
		ui.Tabs(c, &a.src.tab, "Sources", "Workspace", "Artifacts").Label("Data tabs").Changed()
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
	limit := uploadLimitUnknown
	if a.src.maxBytes > 0 {
		limit = "Files up to " + formatBytes(a.src.maxBytes) + ": .csv, .xlsx, .xls, .pdf."
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		button := ui.Button(c, "Import").Tooltip("Import a CSV, Excel or PDF file")
		if a.client == nil || a.src.uploading {
			button.Disabled(true)
		}
		if button.Clicked() {
			a.pickFile()
		}
		ui.MenuButton(c, "Connect", func(m *ui.Menu) {
			for i := range remoteKinds {
				i := i
				if m.Item(remoteKinds[i].Label).Chosen() {
					a.startRemote(i)
				}
			}
		}).Tooltip("Connect a remote data source")
		ui.Spacer(c)
		if len(a.src.sources) > 0 {
			if ui.Button(c, "Remove all").Tooltip("Remove every data source of this chat").Clicked() {
				a.src.confirmKind, a.src.confirmID, a.src.confirmName = confirmSourceAll, "", ""
				a.src.confirmOpen = true
			}
		}
	})
	ui.Text(c, limit).FontSize(12).TextColor(t.TextMuted)
	if a.src.uploading {
		ui.Column(c).Gap(4).Children(func() {
			ui.Textf(c, "Copying %s…", a.src.uploadName).FontSize(12).TextColor(t.TextMuted)
			ui.Progress(c, a.src.uploadProgress).Label("Import progress")
		})
	}
	if a.src.uploadErr != "" {
		ui.Text(c, a.src.uploadErr).FontSize(12).TextColor(t.Danger)
	}
	if len(a.src.sources) == 0 {
		ui.Text(c, "No data sources yet: import a file, or connect a database.").TextColor(t.TextMuted)
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
func (a *app) sourceCard(c *ui.Context, t *ui.Theme, src api.Source) {
	ui.Column(c).Gap(6).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, src.Name).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(src.Name)
			ui.Badge(c, src.Kind)
		})
		state := "closed"
		if src.Open {
			state = "open"
		}
		ui.Textf(c, "%d tables · %s", len(src.Tables), state).FontSize(12).TextColor(t.TextMuted)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			active := src.Active
			ui.Switch(c, &active).Label("Use " + src.Name + " in analysis").Changed()
			if active != src.Active {
				a.setSourceActive(src, active)
			}
			ui.Text(c, "In analysis").FontSize(12).TextColor(t.TextMuted)
			ui.Spacer(c)
			if ui.Button(c, "Preview").Tooltip("Preview the tables of " + src.Name).Clicked() {
				a.showPreview(src.ID)
			}
			if ui.Button(c, "Edit").Tooltip("Edit " + src.Name).Clicked() {
				a.openSourceEditor(src)
			}
			if ui.Button(c, "Remove").Tooltip("Remove " + src.Name).Clicked() {
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
			ui.Text(c, "Preview: "+name).Bold().Grow(1).MinWidth(0).SingleLine()
			if a.src.previewLoading {
				ui.Spinner(c)
			}
		})
		if a.src.previewErr != "" {
			ui.Text(c, a.src.previewErr).FontSize(12).TextColor(t.Danger)
			return
		}
		if a.src.preview == nil {
			ui.Text(c, "Loading the tables…").FontSize(12).TextColor(t.TextMuted)
			return
		}
		if len(a.src.preview.Tables) == 0 {
			ui.Text(c, "This source has no tables.").FontSize(12).TextColor(t.TextMuted)
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
				ui.Textf(c, "%d rows · %d columns", *info.TotalRows, len(info.Columns)).FontSize(12).TextColor(t.TextMuted)
			} else {
				ui.Textf(c, "%d columns · row count not reported", len(info.Columns)).FontSize(12).TextColor(t.TextMuted)
			}
		}
		a.previewTable(c, t)
		ui.Text(c, "Schema").FontSize(12).Bold()
		if a.src.schemaErr != "" {
			ui.Text(c, a.src.schemaErr).FontSize(12).TextColor(t.Danger)
		} else if a.src.schema == "" {
			ui.Text(c, "The service reported no schema.").FontSize(12).TextColor(t.TextMuted)
		} else {
			text := ui.Text(c, a.src.schema).FontSize(12).Selectable().SingleLine()
			if mono := a.monoFont(); mono != "" {
				text.Font(mono)
			}
		}
	})
}

// previewInfo 找出预览里选中的那张表的元信息。
func previewInfo(preview *api.SourcePreview, name string) *api.PreviewTableInfo {
	if preview == nil {
		return nil
	}
	for i := range preview.Tables {
		if preview.Tables[i].Name == name {
			return &preview.Tables[i]
		}
	}
	return nil
}

// previewTable 用 ui.Table 显示前 100 行。
func (a *app) previewTable(c *ui.Context, t *ui.Theme) {
	if a.src.tableErr != "" {
		ui.Text(c, a.src.tableErr).FontSize(12).TextColor(t.Danger)
		return
	}
	rows := a.src.table
	if rows == nil || len(rows.Columns) == 0 {
		ui.Text(c, "No rows to preview.").FontSize(12).TextColor(t.TextMuted)
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
		ui.Text(c, cell).SingleLine().FontSize(12)
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
		ui.Text(c, "Credentials go to the service and never come back to this window.").FontSize(12).TextColor(t.TextMuted)
		if a.src.remoteErr != "" {
			ui.Text(c, a.src.remoteErr).FontSize(12).TextColor(t.Danger)
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
func configsForKind(configs []api.SourceConfig, kind string) []api.SourceConfig {
	var out []api.SourceConfig
	for _, cfg := range configs {
		if cfg.Kind == kind {
			out = append(out, cfg)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// configLabel 是下拉框里的一条配置：有名字用名字，否则用 id。
func configLabel(cfg api.SourceConfig) string {
	if cfg.Name != "" {
		return cfg.Name
	}
	return cfg.ID
}

// workspaceTab 是「工作区」页签：挂载表单、当前挂载与已知目录。
func (a *app) workspaceTab(c *ui.Context, t *ui.Theme) {
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, "Workspace").Bold().FontSize(16)
		ui.Text(c, "The agent reads the files in this folder and writes exports to its artifacts folder.").FontSize(12).TextColor(t.TextMuted)
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
			ui.Text(c, a.src.mountErr).FontSize(12).TextColor(t.Danger)
		}
		if a.src.workspaceErr != "" {
			ui.Text(c, a.src.workspaceErr).FontSize(12).TextColor(t.Danger)
		}
		if current := a.src.current; current != nil {
			ui.Column(c).Gap(6).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Accent.Alpha(0.5)).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, current.Name).Bold().Grow(1).MinWidth(0).SingleLine()
					ui.Badge(c, "mounted")
				})
				ui.Text(c, current.Workdir).FontSize(12).TextColor(t.TextMuted).Selectable()
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
			ui.Text(c, "Known folders").Bold().FontSize(16)
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
				ui.Text(c, ws.Workdir).FontSize(12).TextColor(t.TextMuted).SingleLine().Tooltip(ws.Workdir)
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

// artifactsTab 是「产物」页签：列出导出文件，文本产物就地预览。
func (a *app) artifactsTab(c *ui.Context, t *ui.Theme) {
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "Artifacts").Bold().FontSize(16)
		ui.Spacer(c)
		if ui.Button(c, "Refresh").Tooltip("Reload the artifact list").Clicked() {
			a.loadSources()
		}
	})
	if a.src.artifactsErr != "" {
		ui.Text(c, a.src.artifactsErr).FontSize(12).TextColor(t.Danger)
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
			ui.Textf(c, "%s · %s", formatBytes(art.Size), art.Modified).FontSize(12).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Spacer(c)
				if textArtifact(art.Name) {
					if ui.Button(c, "Preview").Tooltip("Read " + art.Name + " here").Clicked() {
						a.previewArtifact(art)
					}
				} else {
					ui.Text(c, "Open the path to view it").FontSize(12).TextColor(t.TextMuted)
				}
			})
			if a.src.artifactName == art.Name {
				switch {
				case a.src.artifactErr != "":
					ui.Text(c, a.src.artifactErr).FontSize(12).TextColor(t.Danger)
				case !a.src.artifactLoaded:
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Spinner(c)
						ui.Text(c, "Reading…").FontSize(12).TextColor(t.TextMuted)
					})
				default:
					text := ui.Text(c, a.src.artifactText).FontSize(12).Selectable()
					if mono := a.monoFont(); mono != "" {
						text.Font(mono)
					}
				}
			}
			ui.Text(c, art.Path).FontSize(11).TextColor(t.TextMuted).Selectable().SingleLine().Tooltip(art.Path)
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
	var src api.Source
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
		ui.Textf(c, "%s · %d tables", src.Kind, len(src.Tables)).FontSize(12).TextColor(t.TextMuted)
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
			ui.Text(c, "Only a SQL source chooses which tables the agent may analyse.").FontSize(12).TextColor(t.TextMuted)
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
				ui.Text(c, "Reading the tables…").FontSize(12).TextColor(t.TextMuted)
			})
			return
		}
		ui.Text(c, "Tables the agent may analyse").Bold()
		if len(a.src.editTables) == 0 {
			ui.Text(c, "This source reports no tables.").FontSize(12).TextColor(t.TextMuted)
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
			ui.Text(c, a.src.editErr).FontSize(12).TextColor(t.Danger)
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

// sourcesReady 在服务就绪时被 app.go 调用：面板展开就重新加载，否则等展开时再加载。
func (a *app) sourcesReady() {
	if a.client == nil {
		return
	}
	if a.src.open {
		a.loadSources()
	}
}
