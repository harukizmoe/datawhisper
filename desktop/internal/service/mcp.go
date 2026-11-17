package service

import "context"

// McpServer 是 `mcp.list` 的一项：密钥只回显键名，值永远不下发。
type McpServer struct {
	ServerID    string   `json:"server_id"`
	Label       string   `json:"label"`
	Transport   string   `json:"transport"`
	Enabled     bool     `json:"enabled"`
	Description string   `json:"description"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	EnvKeys     []string `json:"envKeys"`
	URL         string   `json:"url"`
	HeaderNames []string `json:"headerNames"`
	Status      string   `json:"status"`
	Tools       int      `json:"tools"`
	LastError   string   `json:"lastError"`
}

// McpList 是 `mcp.list` / `mcp.refresh` 的结果。
type McpList struct {
	Servers []McpServer `json:"servers"`
}

// McpServerInput 是 `mcp.upsert` 与 `mcp.test` 的输入；密钥要重填时写进 Env/Headers。
type McpServerInput struct {
	ServerID    string            `json:"server_id"`
	Label       string            `json:"label"`
	Transport   string            `json:"transport"`
	Enabled     bool              `json:"enabled"`
	Description string            `json:"description"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	Env         map[string]string `json:"env,omitempty"`
	URL         string            `json:"url"`
	Headers     map[string]string `json:"headers,omitempty"`
}

// McpMutation 是保存/删除的结果；失败时 Error 是服务端文案（旧 API 的 400 文案）。
type McpMutation struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

// McpTestResult 是不落盘的连接测试结果。
type McpTestResult struct {
	OK    bool   `json:"ok"`
	Tools int    `json:"tools"`
	Error string `json:"error"`
}

func (c *Client) McpList(ctx context.Context) (McpList, error) {
	var out McpList
	err := c.callInto(ctx, "mcp.list", nil, &out)
	return out, err
}

func (c *Client) McpUpsert(ctx context.Context, server McpServerInput) (McpMutation, error) {
	var out McpMutation
	err := c.callInto(ctx, "mcp.upsert", map[string]any{"server": server}, &out)
	return out, err
}

func (c *Client) McpRemove(ctx context.Context, serverID string) (McpMutation, error) {
	var out McpMutation
	err := c.callInto(ctx, "mcp.remove", map[string]any{"serverId": serverID}, &out)
	return out, err
}

func (c *Client) McpTest(ctx context.Context, server McpServerInput) (McpTestResult, error) {
	var out McpTestResult
	err := c.callInto(ctx, "mcp.test", map[string]any{"server": server}, &out)
	return out, err
}

func (c *Client) McpRefresh(ctx context.Context) (McpList, error) {
	var out McpList
	err := c.callInto(ctx, "mcp.refresh", nil, &out)
	return out, err
}
