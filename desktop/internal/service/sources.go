package service

import "context"

// 本文件包装数据源（source.*）、工作区（workspace.*）与产物（artifact.*）方法，签名与服务端
// server/src/ipc/sources.ts 的方法表一致。返回值只含非密字段：密钥只进不出，`secretFields` 只说明哪些
// 密字段已保存。

// Source 是 source.list 中的一项。Tables 只在服务端打开过该来源后才出现。
type Source struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Active bool     `json:"active"` // 是否参与分析
	Open   bool     `json:"open"`   // 计算侧是否已打开
	Tables []string `json:"tables,omitempty"`
	// ConfigID 是远程来源的连接配置 id（不是密钥）；文件来源没有。有它才能修改连接设置。
	ConfigID string `json:"configId,omitempty"`
}

// SourceNode 是 source.list 的结果。
type SourceNode struct {
	Sources []Source `json:"sources"`
}

// UploadTicket 是 source.upload.begin 的票据：界面把文件字节原样写到 Path（不建目录），再调 OpenUpload。
// MaxBytes 是服务端允许的最大字节数，界面应在写盘之前用它拒绝过大的文件。
type UploadTicket struct {
	UploadID  string `json:"uploadId"`
	Path      string `json:"path"`
	Filename  string `json:"filename"`
	MaxBytes  int64  `json:"maxBytes"`
	ExpiresAt string `json:"expiresAt"`
}

// SourceOpenResult 是 source.open 的结果。ConfigID 只在按远程连接打开时出现。
type SourceOpenResult struct {
	Source   *Source  `json:"source"`
	Sources  []Source `json:"sources"`
	ConfigID string   `json:"configId,omitempty"`
}

// RemoteRequest 是一次远程来源连接。Fields 是非密字段，Secret 是密字段（连接串、服务账号 JSON、认证值），
// ConfigID 指向已保存的配置（非空时服务端以它作为字段与凭据的底稿）。
type RemoteRequest struct {
	Kind     string
	Name     string
	Fields   map[string]string
	Secret   map[string]string
	ConfigID string
}

// SourceToggle 是 source.toggle 的结果。
type SourceToggle struct {
	OK      bool     `json:"ok"`
	Active  bool     `json:"active"`
	Source  Source   `json:"source"`
	Sources []Source `json:"sources"`
}

// PreviewTableInfo 是数据预览里的一张表（不含行数据）。远程 SQL 表的 TotalRows 为 nil。
type PreviewTableInfo struct {
	Name                  string   `json:"name"`
	Columns               []string `json:"columns"`
	TotalRows             *int     `json:"total_rows"`
	SourceID              string   `json:"source_id,omitempty"`
	SourceName            string   `json:"source_name,omitempty"`
	SelectableForAnalysis bool     `json:"selectable_for_analysis,omitempty"`
	SelectedForAnalysis   bool     `json:"selected_for_analysis,omitempty"`
}

// SourcePreview 是 source.preview 的结果。
type SourcePreview struct {
	SourceName             string             `json:"source_name"`
	RequiresTableSelection bool               `json:"requires_table_selection"`
	Tables                 []PreviewTableInfo `json:"tables"`
	Sources                []Source           `json:"sources"`
}

// PreviewTable 是 source.previewTable 的结果：单元格以字符串表示，TotalRows 在远程 SQL 上为 nil。
type PreviewTable struct {
	Name      string     `json:"name"`
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	TotalRows *int       `json:"total_rows"`
}

// Workspace 是工作区的一条记录。Permission 为 "read_only" 或 "read_write"。
type Workspace struct {
	WorkspaceID string `json:"workspace_id"`
	Workdir     string `json:"workdir"`
	Name        string `json:"name"`
	Permission  string `json:"permission"`
	SourceID    string `json:"source_id"`
	Mounted     bool   `json:"mounted"`
	MountedAt   string `json:"mounted_at"`
	UpdatedAt   string `json:"updated_at"`
}

// WorkspaceView 是 workspace.list 的结果：Workspace 是当前挂载的那一个，没有挂载时为 nil。
type WorkspaceView struct {
	Workspace  *Workspace  `json:"workspace"`
	Workspaces []Workspace `json:"workspaces"`
	Sources    []Source    `json:"sources"`
}

// WorkspaceAdded 是 workspace.mount 时新导入的一张表。
type WorkspaceAdded struct {
	SourceName string   `json:"source_name"`
	Tables     []string `json:"tables"`
}

// WorkspaceMount 是 workspace.mount 的结果。Errors 是同步时跳过的文件说明。
type WorkspaceMount struct {
	Workspace *Workspace       `json:"workspace"`
	Sources   []Source         `json:"sources"`
	Added     []WorkspaceAdded `json:"added"`
	Errors    []string         `json:"errors"`
	Skipped   int              `json:"skipped"`
	Reused    int              `json:"reused"`
}

// WorkspaceUpdate 是 workspace.unmount 的结果。
type WorkspaceUpdate struct {
	OK        bool      `json:"ok"`
	Workspace Workspace `json:"workspace"`
	Sources   []Source  `json:"sources"`
}

// WorkspaceList 是 workspace.rename 与 workspace.setPermission 的结果。
type WorkspaceList struct {
	OK         bool        `json:"ok"`
	Workspace  Workspace   `json:"workspace"`
	Workspaces []Workspace `json:"workspaces"`
}

// WorkspaceRemoved 是 workspace.remove 的结果：只删除挂载记录，绝不动目录本身。
type WorkspaceRemoved struct {
	OK          bool   `json:"ok"`
	WorkspaceID string `json:"removed_workspace_id"`
	Files       int    `json:"files_deleted"`
	Directory   bool   `json:"directory_deleted"`
}

// Artifact 是 artifact.list 中的一项。Path 是服务端的绝对路径，界面（同一台机器）直接读文件。
type Artifact struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Modified    string `json:"modified"`
	Root        string `json:"root"`
	WorkspaceID string `json:"workspace_id,omitempty"`
}

// ArtifactContent 是 artifact.read 的结果；Text 只在 as="text" 时出现，且不超过 1 MiB。
type ArtifactContent struct {
	Artifact
	ContentType string `json:"content_type"`
	Text        string `json:"text,omitempty"`
}

// SourceConfig 是一条保存的连接配置：只有非密字段，SecretFields 只说明哪些密字段已保存。
type SourceConfig struct {
	ID           string            `json:"id"`
	Kind         string            `json:"kind"`
	Name         string            `json:"name"`
	Fields       map[string]string `json:"fields"`
	SecretFields []string          `json:"secretFields"`
	UpdatedAt    string            `json:"updatedAt"`
}

// Sources 列出会话的数据来源。
func (c *Client) Sources(ctx context.Context, conversationID int) ([]Source, error) {
	var out SourceNode
	err := c.callInto(ctx, "source.list", conversationIDParams(conversationID), &out)
	return out.Sources, err
}

// BeginUpload 为一次本地文件交接开票。它已经校验了会话、扩展名与声明大小；成功后界面把字节写到 Path。
func (c *Client) BeginUpload(ctx context.Context, conversationID int, filename string, size int64) (UploadTicket, error) {
	params := struct {
		ConversationID int    `json:"conversationId"`
		Filename       string `json:"filename"`
		Size           int64  `json:"size"`
	}{conversationID, filename, size}
	var out UploadTicket
	err := c.callInto(ctx, "source.upload.begin", params, &out)
	return out, err
}

// OpenUpload 认领一次已完成的上传并把它变成数据来源。name 为空时用服务端生成的显示名。
func (c *Client) OpenUpload(ctx context.Context, conversationID int, uploadID, name string) (SourceOpenResult, error) {
	params := map[string]any{"conversationId": conversationID, "uploadId": uploadID}
	if name != "" {
		params["name"] = name
	}
	var out SourceOpenResult
	err := c.callInto(ctx, "source.open", params, &out)
	return out, err
}

// remoteParams 把一次远程连接请求变成 source.open / source.test 共用的参数。
func remoteParams(req RemoteRequest) map[string]any {
	params := map[string]any{"kind": req.Kind}
	if req.ConfigID != "" {
		params["configId"] = req.ConfigID
	}
	if req.Name != "" {
		params["name"] = req.Name
	}
	if len(req.Fields) > 0 {
		params["fields"] = req.Fields
	}
	if len(req.Secret) > 0 {
		params["secret"] = req.Secret
	}
	return params
}

// OpenRemote 连接一个远程来源（sql / gsheets / feishu / http）。密钥随这次调用进入服务端，返回值里没有。
func (c *Client) OpenRemote(ctx context.Context, conversationID int, req RemoteRequest) (SourceOpenResult, error) {
	params := remoteParams(req)
	params["conversationId"] = conversationID
	var out SourceOpenResult
	err := c.callInto(ctx, "source.open", params, &out)
	return out, err
}

// UpdateRemote 修改一个已连接来源的连接设置。服务端先用新设置试连，通过了才保存并重开；
// 失败时旧设置原样保留。req.ConfigID 不用：配置由来源自己引用。
func (c *Client) UpdateRemote(ctx context.Context, conversationID int, sourceID string, req RemoteRequest) (SourceOpenResult, error) {
	params := remoteParams(req)
	delete(params, "configId")
	params["conversationId"] = conversationID
	params["sourceId"] = sourceID
	var out SourceOpenResult
	err := c.callInto(ctx, "source.update", params, &out)
	return out, err
}

// SourceTest 是一次试连接的结果：来源名、目录里的表数，以及（数据库才有的）服务端产品与版本。
type SourceTest struct {
	Name   string `json:"name"`
	Tables int    `json:"tables"`
	Server string `json:"server"`
}

// TestRemote 试连一次远程来源并立即断开；不保存配置，也不加入会话。
func (c *Client) TestRemote(ctx context.Context, req RemoteRequest) (SourceTest, error) {
	var out SourceTest
	err := c.callInto(ctx, "source.test", remoteParams(req), &out)
	return out, err
}

// ReopenSource 重新打开一个已存在但已关闭的来源。
func (c *Client) ReopenSource(ctx context.Context, conversationID int, sourceID string) (SourceOpenResult, error) {
	var out SourceOpenResult
	err := c.callInto(ctx, "source.open", struct {
		ConversationID int    `json:"conversationId"`
		SourceID       string `json:"sourceId"`
	}{conversationID, sourceID}, &out)
	return out, err
}

// CloseSource 在计算侧关闭一个来源；记录、表与参与分析的设置都保留。
func (c *Client) CloseSource(ctx context.Context, conversationID int, sourceID string) ([]Source, error) {
	var out struct {
		OK      bool     `json:"ok"`
		Closed  bool     `json:"closed"`
		Sources []Source `json:"sources"`
	}
	err := c.callInto(ctx, "source.close", sourceIDParams(conversationID, sourceID), &out)
	return out.Sources, err
}

// RemoveSource 删除一个来源的记录（以及它的上传副本）。
func (c *Client) RemoveSource(ctx context.Context, conversationID int, sourceID string) ([]Source, error) {
	var out SourceNode
	err := c.callInto(ctx, "source.remove", sourceIDParams(conversationID, sourceID), &out)
	return out.Sources, err
}

// RemoveAllSources 断开并清空会话的全部来源。
func (c *Client) RemoveAllSources(ctx context.Context, conversationID int) ([]Source, error) {
	var out struct {
		OK      bool     `json:"ok"`
		Removed int      `json:"removed"`
		Sources []Source `json:"sources"`
	}
	err := c.callInto(ctx, "source.removeAll", conversationIDParams(conversationID), &out)
	return out.Sources, err
}

// ToggleSource 打开或关闭一个来源的「参与分析」；active 为 nil 表示由服务端取反。
func (c *Client) ToggleSource(ctx context.Context, conversationID int, sourceID string, active *bool) (SourceToggle, error) {
	params := map[string]any{"conversationId": conversationID, "sourceId": sourceID}
	if active != nil {
		params["active"] = *active
	}
	var out SourceToggle
	err := c.callInto(ctx, "source.toggle", params, &out)
	return out, err
}

// RenameSource 改一个来源在界面里显示的名称；连接设置的修改用 UpdateRemote。
func (c *Client) RenameSource(ctx context.Context, conversationID int, sourceID, name string) (SourceOpenResult, error) {
	var out SourceOpenResult
	err := c.callInto(ctx, "source.rename", map[string]any{"conversationId": conversationID, "sourceId": sourceID, "name": name}, &out)
	return out, err
}

// SourceSchema 返回一个来源的 schema 文本。
func (c *Client) SourceSchema(ctx context.Context, conversationID int, sourceID string) (string, error) {
	var out struct {
		SourceID string `json:"source_id"`
		Schema   string `json:"schema"`
	}
	err := c.callInto(ctx, "source.schema", sourceIDParams(conversationID, sourceID), &out)
	return out.Schema, err
}

// SourceTables 返回一个来源在计算侧的表名。
func (c *Client) SourceTables(ctx context.Context, conversationID int, sourceID string) ([]string, error) {
	var out struct {
		SourceID string   `json:"source_id"`
		Tables   []string `json:"tables"`
	}
	err := c.callInto(ctx, "source.tables", sourceIDParams(conversationID, sourceID), &out)
	return out.Tables, err
}

// PreviewSource 返回一个来源（sourceID 为空时是全部参与分析的来源）的表元信息，不含行数据。
func (c *Client) PreviewSource(ctx context.Context, conversationID int, sourceID string) (SourcePreview, error) {
	params := map[string]any{"conversationId": conversationID}
	if sourceID != "" {
		params["sourceId"] = sourceID
	}
	var out SourcePreview
	err := c.callInto(ctx, "source.preview", params, &out)
	return out, err
}

// PreviewTable 返回某张表的前 100 行。
func (c *Client) PreviewTable(ctx context.Context, conversationID int, sourceID, table string) (PreviewTable, error) {
	var out PreviewTable
	err := c.callInto(ctx, "source.previewTable", struct {
		ConversationID int    `json:"conversationId"`
		SourceID       string `json:"sourceId"`
		Table          string `json:"table"`
	}{conversationID, sourceID, table}, &out)
	return out, err
}

// SetAnalysisTables 设置远程 SQL 来源里参与分析的表。
func (c *Client) SetAnalysisTables(ctx context.Context, conversationID int, sourceID string, tables []string) ([]string, error) {
	if tables == nil {
		tables = []string{}
	}
	var out struct {
		SourceID string   `json:"source_id"`
		Tables   []string `json:"tables"`
	}
	err := c.callInto(ctx, "source.setAnalysisTables", struct {
		ConversationID int      `json:"conversationId"`
		SourceID       string   `json:"sourceId"`
		Tables         []string `json:"tables"`
	}{conversationID, sourceID, tables}, &out)
	return out.Tables, err
}

// Workspaces 读取当前挂载与全部工作区记录（同时带回来源列表）。
func (c *Client) Workspaces(ctx context.Context, conversationID int) (WorkspaceView, error) {
	var out WorkspaceView
	err := c.callInto(ctx, "workspace.list", conversationIDParams(conversationID), &out)
	return out, err
}

// MountWorkspace 把本机目录挂成工作区并导入其中的数据文件。readOnly 决定 agent 能否写盘。
func (c *Client) MountWorkspace(ctx context.Context, conversationID int, path, name string, readOnly bool) (WorkspaceMount, error) {
	permission := "read_write"
	if readOnly {
		permission = "read_only"
	}
	params := map[string]any{"conversationId": conversationID, "path": path, "permission": permission}
	if name != "" {
		params["name"] = name
	}
	var out WorkspaceMount
	err := c.callInto(ctx, "workspace.mount", params, &out)
	return out, err
}

// UnmountWorkspace 卸载一个工作区；workspaceID 为空时卸载当前挂载的那一个。
func (c *Client) UnmountWorkspace(ctx context.Context, conversationID int, workspaceID string) (WorkspaceUpdate, error) {
	params := map[string]any{"conversationId": conversationID}
	if workspaceID != "" {
		params["workspaceId"] = workspaceID
	}
	var out WorkspaceUpdate
	err := c.callInto(ctx, "workspace.unmount", params, &out)
	return out, err
}

// RenameWorkspace 改工作区的显示名。
func (c *Client) RenameWorkspace(ctx context.Context, conversationID int, workspaceID, name string) (WorkspaceList, error) {
	var out WorkspaceList
	err := c.callInto(ctx, "workspace.rename", struct {
		ConversationID int    `json:"conversationId"`
		WorkspaceID    string `json:"workspaceId"`
		Name           string `json:"name"`
	}{conversationID, workspaceID, name}, &out)
	return out, err
}

// SetWorkspacePermission 改一个已挂载工作区的权限（"read_only" 或 "read_write"）。
func (c *Client) SetWorkspacePermission(ctx context.Context, conversationID int, workspaceID, permission string) (WorkspaceList, error) {
	var out WorkspaceList
	err := c.callInto(ctx, "workspace.setPermission", struct {
		ConversationID int    `json:"conversationId"`
		WorkspaceID    string `json:"workspaceId"`
		Permission     string `json:"permission"`
	}{conversationID, workspaceID, permission}, &out)
	return out, err
}

// RemoveWorkspace 删除一条已卸载的工作区记录；目录本身不会被删。
func (c *Client) RemoveWorkspace(ctx context.Context, conversationID int, workspaceID string) (WorkspaceRemoved, error) {
	var out WorkspaceRemoved
	err := c.callInto(ctx, "workspace.remove", struct {
		ConversationID int    `json:"conversationId"`
		WorkspaceID    string `json:"workspaceId"`
		Confirmed      bool   `json:"confirmed"`
	}{conversationID, workspaceID, true}, &out)
	return out, err
}

// Artifacts 列出会话工作区与导出目录里的产物，最新的在前。limit 为 0 时用服务端默认的 200。
func (c *Client) Artifacts(ctx context.Context, conversationID int, workspaceID string, limit int) ([]Artifact, error) {
	params := map[string]any{"conversationId": conversationID}
	if workspaceID != "" {
		params["workspaceId"] = workspaceID
	}
	if limit > 0 {
		params["limit"] = limit
	}
	var out struct {
		Artifacts []Artifact `json:"artifacts"`
	}
	err := c.callInto(ctx, "artifact.list", params, &out)
	return out.Artifacts, err
}

// ReadArtifact 读取一个产物：as 为 "text" 时正文一起返回（上限 1 MiB），否则只有元数据与路径。
func (c *Client) ReadArtifact(ctx context.Context, conversationID int, name, path, as string) (ArtifactContent, error) {
	params := map[string]any{"conversationId": conversationID}
	if name != "" {
		params["name"] = name
	}
	if path != "" {
		params["path"] = path
	}
	if as != "" {
		params["as"] = as
	}
	var out ArtifactContent
	err := c.callInto(ctx, "artifact.read", params, &out)
	return out, err
}

// SourceConfigs 列出保存的数据源配置（只有非密字段）。
func (c *Client) SourceConfigs(ctx context.Context) ([]SourceConfig, error) {
	var out struct {
		Configs []SourceConfig `json:"configs"`
	}
	err := c.callInto(ctx, "source.config.list", nil, &out)
	return out.Configs, err
}

// SaveSourceConfig 保存（或按 id 更新）一条连接配置。secret 省略时保留已保存的凭据。
func (c *Client) SaveSourceConfig(ctx context.Context, cfg SourceConfig, secret map[string]string) (SourceConfig, error) {
	params := map[string]any{"kind": cfg.Kind}
	if cfg.ID != "" {
		params["id"] = cfg.ID
	}
	if cfg.Name != "" {
		params["name"] = cfg.Name
	}
	if cfg.Fields != nil {
		params["fields"] = cfg.Fields
	}
	if secret != nil {
		params["secret"] = secret
	}
	var out struct {
		Config  SourceConfig   `json:"config"`
		Configs []SourceConfig `json:"configs"`
	}
	err := c.callInto(ctx, "source.config.save", params, &out)
	return out.Config, err
}

// RemoveSourceConfig 删除一条连接配置及其凭据。
func (c *Client) RemoveSourceConfig(ctx context.Context, id string) ([]SourceConfig, error) {
	var out struct {
		OK      bool           `json:"ok"`
		Removed string         `json:"removed"`
		Configs []SourceConfig `json:"configs"`
	}
	err := c.callInto(ctx, "source.config.remove", struct {
		ID string `json:"id"`
	}{id}, &out)
	return out.Configs, err
}

func conversationIDParams(conversationID int) map[string]any {
	return map[string]any{"conversationId": conversationID}
}

func sourceIDParams(conversationID int, sourceID string) map[string]any {
	return map[string]any{"conversationId": conversationID, "sourceId": sourceID}
}
