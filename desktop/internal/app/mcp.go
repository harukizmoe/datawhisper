package app

// 设置页「集成 → MCP 服务器」的状态与动作：列表、连接状态、增删改与不落盘的连接测试。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
)

type mcpState struct {
	servers []service.McpServer
	loading bool
	loaded  bool
	busy    bool
	err     string
	notice  string

	open    bool
	form    mcpForm
	formErr string
	testMsg string
}

// mcpForm 是编辑弹窗的草稿。args/env/headers 用逐行文本：一行一个参数或一条 KEY=value。
type mcpForm struct {
	id          string
	label       string
	transport   int // 0 = stdio，1 = SSE
	enabled     bool
	command     string
	args        string
	url         string
	env         string
	headers     string
	description string
	existing    bool
	// 已保存的密钥键名：值不下来，只用来告诉用户哪些已经配置。
	savedEnv     []string
	savedHeaders []string
}

func (a *app) loadMcp() {
	client := a.client
	if client == nil || a.mcp.loading {
		return
	}
	a.mcp.loading = true
	a.mcp.err = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		list, err := client.McpList(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			a.mcp.loading = false
			a.mcp.loaded = true
			if err != nil {
				a.mcp.err = err.Error()
				return
			}
			a.mcp.servers = list.Servers
		})
	}()
}

// reloadMcp 在保存/删除后刷新列表；`busy` 由调用方在动作前后维护。
func (a *app) reloadMcp() {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		list, err := client.McpList(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			a.mcp.busy = false
			if err != nil {
				a.mcp.err = err.Error()
				return
			}
			a.mcp.servers = list.Servers
		})
	}()
}

func (a *app) openMcpEditor(server *service.McpServer) {
	form := mcpForm{transport: 0, enabled: true, existing: server != nil}
	if server != nil {
		form.id = server.ServerID
		form.label = server.Label
		form.enabled = server.Enabled
		form.command = server.Command
		form.args = strings.Join(server.Args, "\n")
		form.url = server.URL
		form.description = server.Description
		if server.Transport == "sse" {
			form.transport = 1
		}
		// 密钥值不下来：只把已配置的键名当提示，留空表示沿用旧值。
		form.env = ""
		form.headers = ""
		form.savedEnv = append([]string(nil), server.EnvKeys...)
		form.savedHeaders = append([]string(nil), server.HeaderNames...)
	}
	a.mcp.form = form
	a.mcp.formErr = ""
	a.mcp.testMsg = ""
	a.mcp.open = true
}

// mcpInput 把草稿转成 RPC 输入。env/headers 留空时字段省略，服务端沿用已保存的密钥。
func (a *app) mcpInput() (service.McpServerInput, string) {
	f := &a.mcp.form
	input := service.McpServerInput{
		ServerID:    strings.TrimSpace(f.id),
		Label:       strings.TrimSpace(f.label),
		Transport:   "stdio",
		Enabled:     f.enabled,
		Description: strings.TrimSpace(f.description),
	}
	if input.ServerID == "" {
		return input, a.tr("settings.mcpNeedServerID")
	}
	if f.transport == 1 {
		input.Transport = "sse"
	}
	if input.Transport == "stdio" {
		input.Command = strings.TrimSpace(f.command)
		input.Args = nonEmptyLines(f.args)
		if input.Command == "" {
			return input, a.tr("settings.mcpNeedCommand")
		}
	} else {
		input.URL = strings.TrimSpace(f.url)
		if input.URL == "" {
			return input, a.tr("settings.mcpNeedURL")
		}
	}
	if env, err := a.parseKeyValues(f.env); err != "" {
		return input, err
	} else if len(env) > 0 {
		input.Env = env
	}
	if headers, err := a.parseKeyValues(f.headers); err != "" {
		return input, err
	} else if len(headers) > 0 {
		input.Headers = headers
	}
	return input, ""
}

func (a *app) saveMcp() {
	client := a.client
	if client == nil || a.mcp.busy {
		return
	}
	input, errText := a.mcpInput()
	if errText != "" {
		a.mcp.formErr = errText
		return
	}
	a.mcp.busy = true
	a.mcp.formErr = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := client.McpUpsert(ctx, input)
		a.post(func() {
			a.mcp.busy = false
			if err != nil {
				a.mcp.formErr = err.Error()
				return
			}
			if !result.OK {
				a.mcp.formErr = result.Error
				return
			}
			a.mcp.open = false
			a.mcp.notice = result.Message
			a.reloadMcp()
		})
	}()
}

func (a *app) testMcp() {
	client := a.client
	if client == nil || a.mcp.busy {
		return
	}
	input, errText := a.mcpInput()
	if errText != "" {
		a.mcp.formErr = errText
		return
	}
	a.mcp.busy = true
	a.mcp.formErr = ""
	a.mcp.testMsg = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		result, err := client.McpTest(ctx, input)
		a.post(func() {
			a.mcp.busy = false
			switch {
			case err != nil:
				a.mcp.testMsg = a.tr("settings.mcpTestFailed", "error", err.Error())
			case !result.OK:
				a.mcp.testMsg = a.tr("settings.mcpTestFailed", "error", result.Error)
			default:
				a.mcp.testMsg = a.tr("settings.mcpTestOk", "count", strconv.Itoa(result.Tools))
			}
		})
	}()
}

func (a *app) removeMcp(serverID string) {
	client := a.client
	if client == nil || a.mcp.busy {
		return
	}
	a.mcp.busy = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := client.McpRemove(ctx, serverID)
		a.post(func() {
			a.mcp.busy = false
			switch {
			case err != nil:
				a.mcp.err = err.Error()
			case !result.OK:
				a.mcp.err = result.Error
			default:
				a.mcp.notice = result.Message
				a.reloadMcp()
			}
		})
	}()
}

// setMcpEnabled 复用保存语义：只改 enabled，密钥留空沿用旧值。
func (a *app) setMcpEnabled(server service.McpServer, enabled bool) {
	client := a.client
	if client == nil || a.mcp.busy {
		return
	}
	previous := server.Enabled
	server.Enabled = enabled
	input := service.McpServerInput{
		ServerID:    server.ServerID,
		Label:       server.Label,
		Transport:   server.Transport,
		Enabled:     enabled,
		Description: server.Description,
		Command:     server.Command,
		Args:        server.Args,
		URL:         server.URL,
	}
	a.mcp.busy = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := client.McpUpsert(ctx, input)
		a.post(func() {
			a.mcp.busy = false
			if err != nil {
				a.mcp.err = err.Error()
			} else if !result.OK {
				a.mcp.err = result.Error
			}
			for i := range a.mcp.servers {
				if a.mcp.servers[i].ServerID == server.ServerID {
					a.mcp.servers[i].Enabled = enabled
					if err != nil || !result.OK {
						a.mcp.servers[i].Enabled = previous
					}
				}
			}
			if err == nil && result.OK {
				a.reloadMcp()
			}
		})
	}()
}

func nonEmptyLines(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// parseKeyValues 解析每行一条 `KEY=value`；失败返回可直接展示的错误。
func (a *app) parseKeyValues(text string) (map[string]string, string) {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return nil, a.tr("settings.mcpBadPair", "line", line)
		}
		out[key] = strings.TrimSpace(value)
	}
	if len(out) == 0 {
		return nil, ""
	}
	return out, ""
}
