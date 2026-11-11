# 桌面端端到端冒烟（真实 server）

`desktop/internal/app/e2e_real_test.go` 是一层「真进程」测试：拉起 `bun run src/main.ts`（它自己再拉起 compute），
用一根本地管道接到界面，发一句话，要求屏幕上出现模型回复。它补的是这层空缺——现有的 `sources_test.go`
用假服务，能测界面逻辑但测不到协议、进程启动与模型流。

## 覆盖什么

- server 进程按 `DW_DATA_DIR` 启动并打印 `ready`；桌面端跳过这一行后接管 stdout。
- 模型提供商从 `models.json` 读（测试写一个自定义 provider），请求打到测试内的 OpenAI 兼容桩。
- 真实的一次回合：`conversation.create` → `submit` → 流式回复 → 界面出现助手消息。
- 断言：对话 id 已落到界面、`chat.Failure` 为空、回复文本与桩返回的一致。

不覆盖：工具调用（需要数据源与 compute 的完整链路）、权限确认、工作区文件树——这些仍由夹具测试覆盖。

## 怎么跑

```bash
cd desktop
DW_E2E_REAL=1 go test ./internal/app -run TestRealServerEndToEnd -v
```

前置：`bun` 在 PATH 里，`server/node_modules` 已安装，仓库根的 `.venv` 可用（server 启动 compute 时要用）。
没有 `DW_E2E_REAL=1` 时测试直接跳过，CI 的桌面任务因此不会因为缺少 bun / Python 而变红。

## 为什么用桩而不是真模型

- 端到端要测的是进程与协议，不是模型质量；桩让结果确定、不需要密钥、不联网。
- 桩实现两个端点：`GET /v1/models`（一个模型）与 `POST /v1/chat/completions`（流式 SSE，固定一句话 + 用量）。
- 需要验证真模型时，改用 `magpie` 网关的 `models.json` 即可（本机 `http://127.0.0.1:3425/v1`，免密钥）。

## 失败时看哪里

- 60 秒内没有 `ready`：把 server 的 stderr 打出来（测试里已经在错误信息里带上）。
- 界面没有回复：先看 `chat.Failure`，再看 server stderr；`DW_DATA_DIR` 是临时目录，测试结束即删。
