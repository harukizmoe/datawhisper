package service

import "context"

// Session 是 session.list 中的一项：会话库（library.sqlite 的 session_meta）里的标题、置顶与
// 归档标记，加上会话本身的时间戳和模型。Title 已由服务端兜底过（session_meta → 首条用户消息），
// 但仍可能是“未命名会话”这类占位文案，界面自行判断。
type Session struct {
	ID          int       `json:"id"`
	Root        bool      `json:"root"`
	Title       string    `json:"title"`
	Pinned      bool      `json:"pinned"`
	Archived    bool      `json:"archived"`
	LastEntryID *int      `json:"lastEntryId"`
	UpdatedAt   *int64    `json:"updatedAt"`
	CreatedAt   *string   `json:"createdAt"`
	Model       *ModelRef `json:"model"`
}

// Sessions 列出会话库里的会话（含归档），按服务的顺序（最新的在前）。标题来自 session_meta，
// 没有标题时是服务端用首条用户消息推出来的。
func (c *Client) Sessions(ctx context.Context) ([]Session, error) {
	var out struct {
		Conversations []Session `json:"conversations"`
	}
	err := c.callInto(ctx, "session.list", nil, &out)
	return out.Conversations, err
}

// RenameSession 改会话在会话库里的标题。服务要求非空，且不超过它的标题长度上限。
func (c *Client) RenameSession(ctx context.Context, id int, title string) (string, error) {
	var out struct {
		Title string `json:"title"`
	}
	err := c.callInto(ctx, "session.rename", struct {
		ID    int    `json:"id"`
		Title string `json:"title"`
	}{id, title}, &out)
	return out.Title, err
}

// Command 是 command.list 中的一项：斜杠命令的公开目录（handler key 不会暴露）。
type Command struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Type         string   `json:"type"`
	Aliases      []string `json:"aliases"`
	Usage        string   `json:"usage"`
	ArgumentHint string   `json:"argumentHint"`
	Arguments    string   `json:"arguments"` // required、optional 或 none
	Category     string   `json:"category"`
	Available    bool     `json:"available"`
	Unavailable  string   `json:"unavailableReason"`
}

// Commands 列出斜杠命令目录，供输入框的补全使用。
func (c *Client) Commands(ctx context.Context) ([]Command, error) {
	var out struct {
		Commands []Command `json:"commands"`
	}
	err := c.callInto(ctx, "command.list", nil, &out)
	return out.Commands, err
}

// PinSession 置顶或取消置顶会话 id。
func (c *Client) PinSession(ctx context.Context, id int, pinned bool) error {
	return c.callInto(ctx, "session.pin", map[string]any{"id": id, "pinned": pinned}, nil)
}

// ArchiveSession 归档或取消归档会话 id；归档的会话不在侧栏的分组里，只在「已归档」里。
func (c *Client) ArchiveSession(ctx context.Context, id int, archived bool) error {
	return c.callInto(ctx, "session.archive", map[string]any{"id": id, "archived": archived}, nil)
}

// DeleteSession 删除会话 id。服务端是软删除（写墓碑），没有恢复的方法；根会话不能删除（invalid_input）。
func (c *Client) DeleteSession(ctx context.Context, id int) error {
	return c.callInto(ctx, "session.delete", map[string]any{"id": id}, nil)
}

// ExportSession 把会话导出成 Markdown（format "md"）或 JSON，返回建议的文件名与正文。
func (c *Client) ExportSession(ctx context.Context, id int, format string) (filename, content string, err error) {
	var out struct {
		Filename string `json:"filename"`
		Content  string `json:"content"`
	}
	err = c.callInto(ctx, "session.export", map[string]any{"id": id, "format": format}, &out)
	return out.Filename, out.Content, err
}

// SessionHit 是 session.search 的一条结果：MatchedIn 是 "title" 或 "body"，Snippet 是命中处的片段。
type SessionHit struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Pinned    bool   `json:"pinned"`
	Archived  bool   `json:"archived"`
	UpdatedAt *int64 `json:"updatedAt"`
	MatchedIn string `json:"matchedIn"`
	Snippet   string `json:"snippet"`
}

// SearchSessions 在会话标题与消息正文里搜索 query，不含已归档的会话。
func (c *Client) SearchSessions(ctx context.Context, query string) ([]SessionHit, error) {
	var out struct {
		Hits []SessionHit `json:"hits"`
	}
	err := c.callInto(ctx, "session.search", map[string]any{"query": query, "limit": 30}, &out)
	return out.Hits, err
}

// Skill 是 skill.list 的一项：agent 可以调用的技能（内置或用户目录里的）。
type Skill struct {
	Name          string   `json:"name"`
	DisplayName   string   `json:"displayName"`
	Description   string   `json:"description"`
	Icon          string   `json:"icon"`
	Source        string   `json:"source"`
	Tags          []string `json:"tags"`
	AllowedTools  []string `json:"allowedTools"`
	ResourceCount int      `json:"resourceCount"`
	PromptChars   int      `json:"promptChars"`
}

// SkillDiagnostic 是读不了的技能文件及原因。
type SkillDiagnostic struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	Error  string `json:"error"`
}

// Skills 列出技能目录（每次都重新读磁盘）。
func (c *Client) Skills(ctx context.Context) ([]Skill, []SkillDiagnostic, error) {
	var out struct {
		Skills      []Skill           `json:"skills"`
		Diagnostics []SkillDiagnostic `json:"diagnostics"`
	}
	err := c.callInto(ctx, "skill.list", nil, &out)
	return out.Skills, out.Diagnostics, err
}
