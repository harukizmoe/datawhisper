package service

// 飞书机器人（feishu.*）：配置、连接状态、测试消息，以及把会话关联到一个群。密钥只写不读：状态里只有
// 「是否已配置」与脱敏后的值，保存时留空表示沿用原来的密钥。

import "context"

// FeishuStatus 是 feishu.status 的结果。
type FeishuStatus struct {
	Enabled                          bool   `json:"enabled"`
	Configured                       bool   `json:"configured"`
	AppID                            string `json:"appId"`
	AppSecretConfigured              bool   `json:"appSecretConfigured"`
	EventVerificationTokenConfigured bool   `json:"eventVerificationTokenConfigured"`
	InboundTransport                 string `json:"inboundTransport"` // long_connection 或 webhook
	ReceiveIDType                    string `json:"receiveIdType"`    // chat_id 或 open_id
	ReceiveID                        string `json:"receiveId"`
	ReceiveIDMasked                  string `json:"receiveIdMasked"`
	InboundStatus                    string `json:"inboundStatus"`
	InboundError                     string `json:"inboundError"`
	Link                             *struct {
		ChatID   string `json:"chatId"`
		ChatName string `json:"chatName"`
	} `json:"link"`
}

// FeishuConfig 是 feishu.setConfig 的参数（整份保存）。AppSecret 与 EventVerificationToken 留空表示沿用。
type FeishuConfig struct {
	Enabled                bool   `json:"enabled"`
	AppID                  string `json:"app_id"`
	AppSecret              string `json:"app_secret,omitempty"`
	EventVerificationToken string `json:"event_verification_token,omitempty"`
	InboundTransport       string `json:"inbound_transport"`
	ReceiveIDType          string `json:"receive_id_type"`
	ReceiveID              string `json:"receive_id"`
}

// FeishuChat 是机器人能看到的一个群。
type FeishuChat struct {
	ChatID string `json:"chat_id"`
	Name   string `json:"name"`
}

// FeishuStatus 返回机器人的配置与连接状态；conv > 0 时一并给出这个会话关联的群。
func (c *Client) FeishuStatus(ctx context.Context, conv int) (FeishuStatus, error) {
	var out FeishuStatus
	var params any
	if conv > 0 {
		params = map[string]any{"conversationId": conv}
	}
	err := c.callInto(ctx, "feishu.status", params, &out)
	return out, err
}

// FeishuSetConfig 保存配置并重连，返回新的状态。
func (c *Client) FeishuSetConfig(ctx context.Context, cfg FeishuConfig) (FeishuStatus, error) {
	var out FeishuStatus
	err := c.callInto(ctx, "feishu.setConfig", cfg, &out)
	return out, err
}

// FeishuTest 向默认目标发一条测试消息。
func (c *Client) FeishuTest(ctx context.Context) (string, error) {
	var out struct {
		Message string `json:"message"`
	}
	err := c.callInto(ctx, "feishu.test", nil, &out)
	return out.Message, err
}

// FeishuChats 列出机器人能看到的群（会请求飞书开放平台）。
func (c *Client) FeishuChats(ctx context.Context) ([]FeishuChat, error) {
	var out []FeishuChat
	err := c.callInto(ctx, "feishu.chats", nil, &out)
	return out, err
}

// FeishuLink 把会话 conv 关联到群 chatID（空表示默认目标），或在 enabled 为 false 时解除关联。
func (c *Client) FeishuLink(ctx context.Context, conv int, enabled bool, chatID string) error {
	params := map[string]any{"conversationId": conv, "enabled": enabled}
	if chatID != "" {
		params["chat_id"] = chatID
	}
	return c.callInto(ctx, "feishu.linkConversation", params, nil)
}
