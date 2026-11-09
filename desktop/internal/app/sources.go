package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
)

// 数据面板（P7.3）：会话的数据来源、工作区与产物。它作为聊天页右侧的 Split 出现，数据按会话加载：
// 来源、工作区、产物都是会话级的，跟着聊天切换比另开一页更自然，也省下侧边栏的导航层。所有写操作成功后
// 都重新拉列表并刷新正在看的预览，用户不需要手动刷新。

// 数据面板的页签。
const (
	sourcesTabSources = iota
	sourcesTabWorkspace
	sourcesTabArtifacts
	sourcesTabRuns
)

// 确认对话框要删的东西。
const (
	confirmSource    = "source"
	confirmSourceAll = "sources-all"
	confirmWorkspace = "workspace"
)

// permissionLabels 是工作区权限的两个标签，顺序与 permissionFromLabel 一致；标签随界面语言变化。
func (a *app) permissionLabels() []string {
	return []string{a.tr("data.permReadOnly"), a.tr("data.permReadWrite")}
}

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

// kindLabel 是远程来源类型在界面语言下的名字。
func (a *app) kindLabel(k remoteKind) string {
	switch k.ID {
	case "sql":
		return a.tr("data.kindSQL")
	case "gsheets":
		return a.tr("data.kindGsheets")
	case "feishu":
		return a.tr("data.kindFeishu")
	case "http":
		return a.tr("data.kindHTTP")
	}
	return k.Label
}

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

	sources []service.Source

	// runs 是「运行」标签的数据（runs.go）。
	runs runsState

	// 预览：previewID 是正在看的来源，previewTable 是选中的表。
	previewID      string
	preview        *service.SourcePreview
	previewErr     string
	previewTable   string
	table          *service.PreviewTable
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
	sql            sqlForm // SQL 来源的表单字段
	testBusy       bool    // 正在试连接
	testNote       string  // 试连接的结果文案
	testFail       bool    // testNote 是失败原因
	configs        []service.SourceConfig
	configsErr     string

	// 工作区。
	current      *service.Workspace
	workspaces   []service.Workspace
	workspaceErr string
	mountPath    string
	mountName    string
	mountPerm    int // 0 read_only / 1 read_write
	mountBusy    bool
	mountErr     string
	permBusy     string // 正在改权限的 workspaceId

	// 产物。
	artifacts      []service.Artifact
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

	// queue 是等待导入的路径（从窗口拖进来的文件）。一次只导入一个，见 startImport。
	queue []string
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
				a.src.err = a.sourceErr(sourcesErr)
			default:
				a.src.sources, a.src.err = sources, ""
			}
			if workspaceErr != nil {
				a.src.workspaceErr = a.sourceErr(workspaceErr)
			} else {
				a.src.current = view.Workspace
				a.src.workspaces = view.Workspaces
				a.src.workspaceErr = ""
			}
			if artifactsErr != nil {
				a.src.artifactsErr = a.sourceErr(artifactsErr)
			} else {
				a.src.artifacts, a.src.artifactsErr = artifacts, ""
			}
			if configsErr != nil {
				a.src.configsErr = a.sourceErr(configsErr)
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

func hasSource(sources []service.Source, id string) bool {
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
		sp, err := client.PreviewSource(ctx, conv, sourceID)
		schema, schemaErr := client.SourceSchema(ctx, conv, sourceID)
		var rows service.PreviewTable
		var rowsErr error
		chosen := table
		if err == nil {
			if chosen == "" || !hasPreviewTable(sp.Tables, chosen) {
				chosen = firstTable(sp.Tables)
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
				a.src.previewErr = a.tr("data.readTablesFailed", "error", a.sourceErr(err))
				return
			}
			a.src.preview = &sp
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

func hasPreviewTable(tables []service.PreviewTableInfo, name string) bool {
	for _, t := range tables {
		if t.Name == name {
			return true
		}
	}
	return false
}

func firstTable(tables []service.PreviewTableInfo) string {
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
			Title:   a.tr("data.importDialogTitle"),
			Message: a.tr("data.importDialogMsg"),
			Filters: []mygo.FileFilter{{Name: a.tr("data.importFilter"), Extensions: []string{"csv", "xlsx", "xls", "pdf"}}},
		})
		if err != nil {
			a.post(func() { a.src.uploadErr = a.tr("data.dialogUnavailable", "error", err.Error()) })
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
		a.src.uploadErr = a.tr("data.importNeedChat")
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		a.src.uploadErr = a.tr("data.readFailed", "path", path, "error", err.Error())
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
				a.src.uploading = false
				if client == a.client {
					a.src.uploadErr = a.sourceErr(err)
				}
				a.startImport()
			})
			return
		}
		a.post(func() { a.src.maxBytes = ticket.MaxBytes })
		// 服务端声明的上限比本地文件小：现在拒绝，票据自然过期，绝不先写盘。
		if ticket.MaxBytes > 0 && size > ticket.MaxBytes {
			a.post(func() {
				a.src.uploading = false
				if client == a.client {
					a.src.uploadErr = oversizeText(filename, size, ticket.MaxBytes)
				}
				a.startImport()
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
				a.src.uploading = false
				if client == a.client {
					a.src.uploadErr = a.tr("data.copyFailed", "name", filename, "error", err.Error())
				}
				a.startImport()
			})
			return
		}
		opened, err := client.OpenUpload(ctx, conv, ticket.UploadID, "")
		a.post(func() {
			a.src.uploading = false
			if client != a.client {
				a.startImport()
				return
			}
			if err != nil {
				a.src.uploadErr = a.sourceErr(err)
				a.startImport()
				return
			}
			name := filename
			if opened.Source != nil && opened.Source.Name != "" {
				name = opened.Source.Name
			}
			a.src.notice, a.src.noticeErr = a.tr("data.imported", "name", name), false
			a.loadSources()
			a.startImport()
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
func (a *app) setSourceActive(src service.Source, on bool) {
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
				a.src.notice, a.src.noticeErr = a.tr("data.changeFailed", "name", src.Name, "error", a.sourceErr(err)), true
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
func (a *app) openSource(src service.Source) {
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
				a.src.notice, a.src.noticeErr = a.tr("data.openFailed", "name", src.Name, "error", a.sourceErr(err)), true
				return
			}
			a.src.notice, a.src.noticeErr = src.Name+" is open.", false
			a.loadSources()
		})
	}()
}

// closeSource 在计算侧关闭一个来源。
func (a *app) closeSource(src service.Source) {
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
				a.src.notice, a.src.noticeErr = a.tr("data.closeFailed", "name", src.Name, "error", a.sourceErr(err)), true
				return
			}
			a.src.notice, a.src.noticeErr = src.Name+" is closed.", false
			a.loadSources()
		})
	}()
}

// removeSource 删除一个来源的记录。
func (a *app) removeSource(src service.Source) {
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
				a.src.notice, a.src.noticeErr = a.tr("data.removeFailed", "name", src.Name, "error", a.sourceErr(err)), true
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
				a.src.notice, a.src.noticeErr = a.tr("data.removeSourcesFailed", "error", a.sourceErr(err)), true
				return
			}
			a.src.previewID, a.src.preview, a.src.table = "", nil, nil
			a.src.previewTable, a.src.schema = "", ""
			a.src.notice, a.src.noticeErr = a.tr("data.allRemoved"), false
			a.loadSources()
		})
	}()
}

// sqlDriver 是 SQL 表单里的一种数据库类型：id 与服务端一致；File 表示只需要一个文件（SQLite），
// SSL 表示有「要求加密」开关。名字是产品名，不翻译。
type sqlDriver struct {
	ID    string
	Label string
	Port  string
	SSL   bool
	File  bool
}

var sqlDrivers = []sqlDriver{
	{ID: "postgresql", Label: "PostgreSQL", Port: "5432", SSL: true},
	{ID: "mysql", Label: "MySQL / MariaDB", Port: "3306"},
	{ID: "mssql", Label: "SQL Server", Port: "1433", SSL: true},
	{ID: "sqlite", Label: "SQLite", File: true},
}

// sqlForm 是 SQL 来源表单：默认按类型填字段（连接串由服务端拼，密码里的特殊字符不用转义），
// advanced 时才直接填连接串。密码和连接串都只存在输入框里。
type sqlForm struct {
	driver    int // sqlDrivers 的下标
	host      string
	port      string
	database  string
	user      string
	password  string
	file      string
	ssl       bool
	advanced  bool
	savedConn bool // 选中的已保存配置里有连接串（高级模式下留空即沿用）
}

// sqlFormFrom 把已保存配置的非密字段填回表单；密码与连接串不回填。
func sqlFormFrom(cfg service.SourceConfig) sqlForm {
	f := sqlForm{
		host:     cfg.Fields["host"],
		port:     cfg.Fields["port"],
		database: cfg.Fields["database"],
		user:     cfg.Fields["username"],
		file:     cfg.Fields["file"],
		ssl:      cfg.Fields["ssl"] == "true",
	}
	for i, d := range sqlDrivers {
		if d.ID == cfg.Fields["driver"] {
			f.driver = i
		}
	}
	f.savedConn = slices.Contains(cfg.SecretFields, "connection_string")
	// 旧配置只有连接串、没有 driver 字段：打开时直接进高级模式。
	f.advanced = cfg.Fields["driver"] == "" && f.savedConn
	return f
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
	a.src.sql = sqlForm{}
	a.src.testNote, a.src.testFail = "", false
}

// useConfig 把一条已保存配置的非密字段填进表单；密字段只提示已保存，绝不回填值。
func (a *app) useConfig(cfg service.SourceConfig) {
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
	a.src.sql = sqlForm{}
	if cfg.Kind == "sql" {
		a.src.sql = sqlFormFrom(cfg)
	}
	a.src.testNote, a.src.testFail = "", false
	// 已保存的凭据不回到界面：输入框留空，占位符说明它已存在。
	a.src.remoteConn, a.src.remoteCreds, a.src.remoteAuthVal = "", "", ""
}

// sqlRequest 把 SQL 表单变成请求的字段与密文；失败时返回要给用户看的原因。
// 每个键都显式给出（空串表示清除），否则服务端会沿用「最近保存的同类配置」里的旧值：
// 比如新建连接却带上了旧的连接串或密码。已保存配置里没改的密码才用省略来表示「保持」。
func (a *app) sqlRequest() (fields, secret map[string]string, problem string) {
	f := a.src.sql
	saved := a.src.remoteConfigID != ""
	fields = map[string]string{"driver": "", "host": "", "port": "", "database": "", "username": "", "ssl": "", "file": ""}
	secret = map[string]string{}
	if f.advanced {
		if a.src.remoteConn == "" && !(saved && f.savedConn) {
			return nil, nil, a.tr("data.enterConn")
		}
		if !saved {
			secret["password"] = ""
		}
		if a.src.remoteConn != "" {
			secret["connection_string"] = a.src.remoteConn
		}
		return fields, secret, ""
	}
	drv := sqlDrivers[f.driver]
	fields["driver"] = drv.ID
	secret["connection_string"] = ""
	if drv.File {
		fields["file"] = strings.TrimSpace(f.file)
		if fields["file"] == "" {
			return nil, nil, a.tr("data.errMissingFile")
		}
		secret["password"] = ""
		return fields, secret, ""
	}
	fields["host"] = strings.TrimSpace(f.host)
	if fields["host"] == "" {
		return nil, nil, a.tr("data.errMissingHost")
	}
	fields["port"] = strings.TrimSpace(f.port)
	fields["database"] = strings.TrimSpace(f.database)
	fields["username"] = strings.TrimSpace(f.user)
	if drv.SSL {
		fields["ssl"] = strconv.FormatBool(f.ssl)
	}
	switch {
	case f.password != "":
		secret["password"] = f.password
	case !saved:
		secret["password"] = ""
	}
	return fields, secret, ""
}

// remoteRequest 把表单变成一次连接请求，「添加」和「测试连接」共用；校验失败时把原因写进 remoteErr。
func (a *app) remoteRequest() (service.RemoteRequest, bool) {
	kind := remoteKinds[a.src.remoteKind]
	req := service.RemoteRequest{Kind: kind.ID, Name: strings.TrimSpace(a.src.remoteName), ConfigID: a.src.remoteConfigID}
	switch kind.ID {
	case "sql":
		fields, secret, problem := a.sqlRequest()
		if problem != "" {
			a.src.remoteErr = problem
			return req, false
		}
		req.Fields, req.Secret = fields, secret
	case "gsheets":
		req.Fields = map[string]string{"spreadsheet": strings.TrimSpace(a.src.remoteSpread)}
		req.Secret = map[string]string{}
		if a.src.remoteCreds != "" {
			req.Secret["creds_json"] = a.src.remoteCreds
		}
		if req.Fields["spreadsheet"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = a.tr("data.enterSpread")
			return req, false
		}
	case "feishu":
		req.Fields = map[string]string{
			"bitable": strings.TrimSpace(a.src.remoteBitable),
			"table":   strings.TrimSpace(a.src.remoteTable),
		}
		if req.Fields["bitable"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = a.tr("data.enterBitable")
			return req, false
		}
	case "http":
		authTypes := []string{"none", "bearer", "api_key"}
		req.Fields = map[string]string{"url": strings.TrimSpace(a.src.remoteURL), "auth_type": authTypes[a.src.remoteAuth]}
		req.Secret = map[string]string{}
		if a.src.remoteAuthVal != "" {
			req.Secret["auth_value"] = a.src.remoteAuthVal
		}
		if req.Fields["url"] == "" && a.src.remoteConfigID == "" {
			a.src.remoteErr = a.tr("data.enterURL")
			return req, false
		}
	}
	if len(req.Secret) == 0 {
		req.Secret = nil
	}
	return req, true
}

// connectRemote 提交远程连接表单。密钥只随这一次请求离开界面。
func (a *app) connectRemote() {
	client, conv := a.client, a.src.conv
	if client == nil || conv == 0 {
		a.src.remoteErr = a.tr("data.connectNeedChat")
		return
	}
	a.src.testNote, a.src.testFail = "", false
	req, ok := a.remoteRequest()
	if !ok {
		return
	}
	kind := remoteKinds[a.src.remoteKind]
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
				a.src.remoteErr = a.sourceErr(err)
				return
			}
			name := a.kindLabel(kind)
			if opened.Source != nil && opened.Source.Name != "" {
				name = opened.Source.Name
			}
			// 密钥只写不读：成功后立刻清空输入框。
			a.src.remoteConn, a.src.remoteCreds, a.src.remoteAuthVal = "", "", ""
			a.src.sql.password = ""
			a.src.remoteOpen, a.src.remoteErr = false, ""
			a.src.notice, a.src.noticeErr = a.tr("data.connected", "name", name), false
			// 远程 SQL 来源连上后默认不向 agent 开放任何表：直接引导用户选表，而不是等他自己找到「编辑」。
			if kind.ID == "sql" && opened.Source != nil {
				if len(opened.Sources) > 0 {
					a.src.sources = opened.Sources
				}
				a.openSourceEditor(*opened.Source, true)
			}
			a.loadSources()
		})
	}()
}

// testRemote 试连一次当前表单：不保存配置，也不把来源加进会话。结果显示在表单底部。
func (a *app) testRemote() {
	client := a.client
	if client == nil {
		a.src.remoteErr = a.tr("data.connectNeedChat")
		return
	}
	a.src.remoteErr = ""
	req, ok := a.remoteRequest()
	if !ok {
		return
	}
	a.src.testBusy, a.src.testNote, a.src.testFail = true, "", false
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res, err := client.TestRemote(ctx, req)
		a.post(func() {
			if client != a.client {
				return
			}
			a.src.testBusy = false
			if err != nil {
				a.src.testNote, a.src.testFail = a.sourceErr(err), true
				return
			}
			label := res.Server
			if label == "" {
				label = res.Name
			}
			a.src.testNote = a.tr("data.testOK", "server", label, "tables", strconv.Itoa(res.Tables))
		})
	}()
}

// pickDatabaseFile 打开系统的选文件对话框，把选中的 SQLite 文件路径填进表单。
func (a *app) pickDatabaseFile() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Title:   a.tr("data.sqlFileDialogTitle"),
			Filters: []mygo.FileFilter{{Name: a.tr("data.sqlFileFilter"), Extensions: []string{"db", "sqlite", "sqlite3", "db3"}}},
		})
		if err != nil {
			a.post(func() { a.src.remoteErr = a.tr("data.dialogUnavailable", "error", err.Error()) })
			return
		}
		if len(paths) == 0 {
			return // 用户取消
		}
		path := paths[0]
		a.post(func() { a.src.sql.file = path })
	}()
}

// removeConfig 删除一条保存的连接配置。
func (a *app) removeConfig(cfg service.SourceConfig) {
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
				a.src.notice, a.src.noticeErr = a.tr("data.forgetFailed", "error", a.sourceErr(err)), true
				return
			}
			if a.src.remoteConfigID == cfg.ID {
				a.src.remoteConfigID = ""
			}
			a.src.notice, a.src.noticeErr = a.tr("data.forgotten"), false
			a.loadSources()
		})
	}()
}

// mountWorkspace 把输入的目录挂成工作区。
func (a *app) mountWorkspace() {
	client, conv := a.client, a.src.conv
	path := strings.TrimSpace(a.src.mountPath)
	if client == nil || conv == 0 {
		a.src.mountErr = a.tr("data.mountNeedChat")
		return
	}
	if path == "" {
		a.src.mountErr = a.tr("data.enterFolder")
		return
	}
	if !filepath.IsAbs(path) {
		a.src.mountErr = a.tr("data.absPath")
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
				a.src.mountErr = a.sourceErr(err)
				return
			}
			label := path
			if out.Workspace != nil && out.Workspace.Name != "" {
				label = out.Workspace.Name
			}
			a.src.mountPath, a.src.mountName, a.src.mountErr = "", "", ""
			if len(out.Errors) > 0 {
				a.src.notice, a.src.noticeErr = a.tr("data.mountedSkipped", "label", label, "skipped", strings.Join(out.Errors, "; ")), true
			} else {
				a.src.notice, a.src.noticeErr = a.tr("data.mounted", "label", label), false
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
				a.src.notice, a.src.noticeErr = a.tr("data.unmountFailed", "error", a.sourceErr(err)), true
				return
			}
			a.src.notice, a.src.noticeErr = a.tr("data.unmounted"), false
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
				a.src.notice, a.src.noticeErr = a.tr("data.folderRemoveFailed", "error", a.sourceErr(err)), true
				return
			}
			a.src.notice, a.src.noticeErr = a.tr("data.folderRemoved"), false
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
				a.src.notice, a.src.noticeErr = a.tr("data.permFailed", "error", a.sourceErr(err)), true
				return
			}
			a.src.notice, a.src.noticeErr = a.tr("data.permSaved"), false
			a.loadSources()
		})
	}()
}

// maxAnalysisTables 是一个 SQL 来源最多能选几张分析表，与 compute 的上限一致。
const maxAnalysisTables = 20

// openSourceEditor 打开来源编辑对话框：SQL 来源在这里选分析表，所有来源都能在这里开关。
// firstTime 表示这是刚连上、还没选过表的来源（连接成功后自动弹出，或卡片上的「选择数据表」），此时会默认勾选。
func (a *app) openSourceEditor(src service.Source, firstTime bool) {
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
		sp, err := client.PreviewSource(ctx, conv, src.ID)
		a.post(func() {
			if client != a.client || a.src.editID != src.ID {
				return
			}
			a.src.editBusy = false
			if err != nil {
				a.src.editErr = a.tr("data.readTablesFailed", "error", a.sourceErr(err))
				return
			}
			a.src.editTables = nil
			for _, t := range sp.Tables {
				a.src.editTables = append(a.src.editTables, t.Name)
				if t.SelectedForAnalysis {
					a.src.editPicked[t.Name] = true
				}
			}
			// 第一次选表时，库里的表不多就默认全选：用户多半是想分析整个库，省得对着一排空框发愣；
			// 表太多时不替用户挑，留空让他自己勾。
			if firstTime && len(a.src.editPicked) == 0 && len(a.src.editTables) <= maxAnalysisTables {
				for _, name := range a.src.editTables {
					a.src.editPicked[name] = true
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
				a.src.editErr = a.sourceErr(err)
				return
			}
			a.src.editOpen = false
			a.src.notice, a.src.noticeErr = fmt.Sprintf("%d tables are used in analysis.", len(picked)), false
			a.loadSources()
		})
	}()
}

// previewArtifact 读取一个产物的文本；不能内联预览的产物只提示路径。
func (a *app) previewArtifact(art service.Artifact) {
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
				var e *service.Error
				if errors.As(err, &e) && e.Reason == "file_too_large" {
					// 产物无法内联预览时只说明路径，用户自己在系统里打开。
					a.src.artifactErr = a.tr("data.artifactTooLarge", "path", art.Path)
					return
				}
				a.src.artifactErr = a.sourceErr(err)
				return
			}
			a.src.artifactText = content.Text
		})
	}()
}

// sourceErrorText 把数据源/工作区/产物方法的错误翻成用户能照着做的话（英文）；没有 app 可用的调用方走这个，
// 有 app 的调用方用 sourceErr，让文案跟随界面语言。
func sourceErrorText(err error) string {
	return sourceErrorIn(i18n.EN, err)
}

// sourceErr 同 sourceErrorText，但按界面语言给出文案。
func (a *app) sourceErr(err error) string {
	return sourceErrorIn(a.lang, err)
}

// sourceErrorIn 是 sourceErrorText 的实现；上传被拒的每种 reason 单独说明。
func sourceErrorIn(lang string, err error) string {
	tr := func(key string, args ...string) string { return i18n.T(lang, key, args...) }
	var e *service.Error
	if errors.As(err, &e) {
		switch e.Reason {
		case "unsupported_format":
			return tr("data.errUnsupportedFormat")
		case "empty_file":
			return tr("data.errEmptyFile")
		case "file_too_large":
			return tr("data.errFileTooLarge", "message", e.Message)
		case "upload_missing":
			return tr("data.errUploadMissing")
		case "upload_not_file":
			return tr("data.errUploadNotFile")
		case "upload_outside_root":
			return tr("data.errUploadOutside")
		case "upload_size_mismatch":
			return tr("data.errUploadSize")
		case "unknown_upload", "upload_expired":
			return tr("data.errImportExpired")
		case "invalid_workdir":
			return tr("data.errInvalidWorkdir", "message", e.Message)
		case "not_mounted":
			return tr("data.errNotMounted")
		case "workspace_connected":
			return tr("data.errWorkspaceConnected")
		case "confirmation_required":
			return tr("data.errConfirmRequired")
		case "not_sql_source":
			return tr("data.errNotSQL")
		case "invalid_credentials":
			return tr("data.errInvalidCreds")
		case "missing_driver", "unsupported_driver":
			return tr("data.errMissingDriver")
		case "missing_host":
			return tr("data.errMissingHost")
		case "invalid_port":
			return tr("data.errInvalidPort")
		case "missing_file":
			return tr("data.errMissingFile")
		case "invalid_database", "invalid_file":
			return tr("data.errInvalidChar")
		case "missing_spreadsheet":
			return tr("data.enterSpread")
		case "missing_bitable":
			return tr("data.enterBitable")
		case "missing_table":
			return tr("data.errMissingTable")
		case "invalid_bitable":
			return tr("data.errInvalidBitable")
		case "missing_url":
			return tr("data.enterURL")
		case "invalid_url":
			return tr("data.errInvalidURL")
		case "invalid_auth_type":
			return tr("data.errInvalidAuth")
		case "missing_auth_value":
			return tr("data.errMissingAuth")
		case "config_kind_mismatch":
			return tr("data.errConfigKind")
		case "invalid_descriptor":
			return tr("data.errInvalidDescriptor")
		case "preview_failed":
			return tr("data.errPreviewFailed", "message", e.Message)
		case "invalid_artifact_name":
			return tr("data.errArtifactName")
		case "invalid_workspace_name":
			return e.Message
		}
		if e.Kind == "not_found" {
			return tr("data.errNotFound", "message", e.Message)
		}
		switch e.Code {
		case -32601:
			return tr("data.errNoMethod")
		case -32602:
			return tr("data.errRejected", "message", e.Message)
		case -32000:
			return tr("data.errCouldNot", "message", e.Message)
		case -32603:
			return tr("data.errFailed", "message", e.Message)
		}
	}
	if errors.Is(err, service.ErrClosed) {
		return tr("data.errNotRunning")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return tr("data.errTimeout")
	}
	return err.Error()
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
