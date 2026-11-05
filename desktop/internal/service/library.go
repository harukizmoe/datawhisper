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
