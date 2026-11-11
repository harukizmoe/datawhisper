package service

import "context"

// Task 是 agent 的任务板（task_create 等工具维护）里的一项。任务板不在订阅推送的视图里，
// 所以界面在任务工具完成后用 tasks.list 重新读取。
type Task struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Assignee string `json:"assignee"`
	// Status 取 pending、in_progress、completed 或 blocked。
	Status string `json:"status"`
}

// Tasks 读出会话 conv 的任务板，按创建顺序。
func (c *Client) Tasks(ctx context.Context, conv int) ([]Task, error) {
	var out struct {
		Tasks []Task `json:"tasks"`
	}
	err := c.callInto(ctx, "tasks.list", map[string]any{"conversationId": conv}, &out)
	return out.Tasks, err
}
