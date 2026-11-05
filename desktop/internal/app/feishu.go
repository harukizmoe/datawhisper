package app

// 设置页「集成」分区的状态与动作：飞书机器人的配置、连接状态、测试消息，以及把当前会话关联到一个群。
// 密钥只写不读：表单里的密钥框留空表示沿用已保存的值。

import (
	"context"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
)

type feishuState struct {
	loading bool
	loaded  bool
	err     string
	notice  string
	busy    bool

	status      service.FeishuStatus
	unavailable bool // 服务没装配飞书（method not found）

	// 表单：载入状态时用已保存的值填好（密钥除外）。
	enabled   bool
	appID     string
	appSecret string
	token     string
	transport int // 0 长连接，1 webhook
	idType    int // 0 chat_id，1 open_id
	receiveID string

	chats []service.FeishuChat
}

// loadFeishu 读取飞书状态（含当前会话的关联），并用它填表单。
func (a *app) loadFeishu() {
	client, conv := a.client, a.conv
	f := &a.feishu
	if client == nil || f.loading {
		return
	}
	f.loading = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		st, err := client.FeishuStatus(ctx, conv)
		a.post(func() {
			f := &a.feishu
			f.loading, f.loaded = false, true
			if service.IsUnavailable(err) {
				f.unavailable = true
				return
			}
			if err != nil {
				f.err = sourceErrorText(err)
				return
			}
			f.err = ""
			a.fillFeishuForm(st)
		})
	}()
}

func (a *app) fillFeishuForm(st service.FeishuStatus) {
	f := &a.feishu
	f.status = st
	f.enabled, f.appID, f.receiveID = st.Enabled, st.AppID, st.ReceiveID
	f.appSecret, f.token = "", ""
	f.transport, f.idType = 0, 0
	if st.InboundTransport == "webhook" {
		f.transport = 1
	}
	if st.ReceiveIDType == "open_id" {
		f.idType = 1
	}
}

// feishuCall 在后台调用 fn；成功后显示 notice 并重新读取状态。
func (a *app) feishuCall(notice string, fn func(ctx context.Context, c *service.Client) (string, error)) {
	client := a.client
	f := &a.feishu
	if client == nil || f.busy {
		return
	}
	f.busy, f.err, f.notice = true, "", ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		msg, err := fn(ctx, client)
		a.post(func() {
			f := &a.feishu
			f.busy = false
			if err != nil {
				f.err = sourceErrorText(err)
				return
			}
			f.notice = notice
			if msg != "" {
				f.notice = msg
			}
			a.loadFeishu()
		})
	}()
}

// saveFeishu 保存表单（整份），服务端随后重连。
func (a *app) saveFeishu() {
	f := &a.feishu
	cfg := service.FeishuConfig{
		Enabled:                f.enabled,
		AppID:                  strings.TrimSpace(f.appID),
		AppSecret:              strings.TrimSpace(f.appSecret),
		EventVerificationToken: strings.TrimSpace(f.token),
		InboundTransport:       []string{"long_connection", "webhook"}[f.transport],
		ReceiveIDType:          []string{"chat_id", "open_id"}[f.idType],
		ReceiveID:              strings.TrimSpace(f.receiveID),
	}
	a.feishuCall(a.tr("feishu.saved"), func(ctx context.Context, c *service.Client) (string, error) {
		_, err := c.FeishuSetConfig(ctx, cfg)
		return "", err
	})
}

// testFeishu 向默认目标发一条测试消息。
func (a *app) testFeishu() {
	a.feishuCall(a.tr("feishu.testSent"), func(ctx context.Context, c *service.Client) (string, error) {
		return c.FeishuTest(ctx)
	})
}

// loadFeishuChats 列出机器人能看到的群，供关联当前会话时选择（会请求飞书开放平台）。
func (a *app) loadFeishuChats() {
	client := a.client
	f := &a.feishu
	if client == nil || f.busy {
		return
	}
	f.busy, f.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		chats, err := client.FeishuChats(ctx)
		a.post(func() {
			f := &a.feishu
			f.busy = false
			if err != nil {
				f.err = sourceErrorText(err)
				return
			}
			f.chats = chats
		})
	}()
}

// linkFeishu 把当前会话关联到群 chatID（空表示默认目标），或解除关联。
func (a *app) linkFeishu(enabled bool, chatID string) {
	conv := a.conv
	if conv == 0 {
		return
	}
	notice := a.tr("feishu.linked")
	if !enabled {
		notice = a.tr("feishu.unlinked")
	}
	a.feishuCall(notice, func(ctx context.Context, c *service.Client) (string, error) {
		return "", c.FeishuLink(ctx, conv, enabled, chatID)
	})
}
