# 界面与 agent 服务之间的传输：改用 stdio JSONL

状态：已确认（替代原计划的 loopback HTTP + 令牌）
影响任务：P2.1、P2.2、P2.3 的传输部分，以及 P7.2 的 Web view 资源加载

## 1. 为什么改

原计划让 Bun 服务监听 `127.0.0.1` 随机端口、用每次启动生成的令牌鉴权，理由是 Hono/SSE 现成、Web view 需要一个 origin、命令行能直接调试。评估后这三个理由都不足以抵消代价：

- 端口是新的失败源（占用、防火墙、IPv6/代理环境变量干扰），而这些在桌面应用里本不该存在；
- 令牌必须进 Web view 的 URL（`?token=`），等于把密钥写进页面地址、历史记录和可能的日志；
- 本机任意进程都能尝试连接，安全性靠令牌而不是内核权限；
- 仓库里已有 `compute/rpc.py` 一套 stdio JSON-RPC，UI 链路再造一套 HTTP + SSE，等于维护两套流式语义与两套错误处理。

`@earendil-works/pi-coding-agent@1.5.0`（同一技术栈的成熟实现）对这类场景的选择是明确的：同语言同进程用 SDK 直接调用，**语言无关的独立 UI 走 RPC 模式——stdin/stdout 上的 JSONL 命令、响应与事件**（`docs/rpc.md`：*Use it for language-independent integrations, process isolation, IDEs, and custom user interfaces*）。我们正是"Go UI + Bun agent，两个进程"。

另外核实：`mygo@v0.7.4` 的 Web view 支持 `LoadHTML` 与可信自定义 scheme（`docs/ui/web-view.md`），所以 Web view 不需要 agent 服务提供 HTTP origin。

## 2. 采用的协议

沿用 `compute/rpc.py` 的 **JSON-RPC 2.0 + JSONL 分帧**，不另发明记录风格。理由：仓库里只保留一种协议实现，客户端库、错误码、取消语义、测试工具都能共享；pi 用扁平 `type` 记录是因为它还要兼顾 JSON 单向模式，我们不需要。

分帧规则（与 pi 的 RPC 文档一致，也与我们的 compute 一致）：

- 一条记录一个 JSON 对象，以 `\n` 结尾；只按 LF 切分，**不得**用会同时识别 `U+2028`/`U+2029` 的行读取器；
- stdin 只收请求/通知，stdout 只发响应/通知，**日志与诊断一律走 stderr**；
- 请求可带 `id`，响应原样回带；处理是异步的，客户端按 `id` 关联，不依赖顺序；
- 关闭 stdin = 请求有序退出；supervisor 仍要处理信号与意外退出。

## 3. 方法与通知

请求（客户端 → 服务）：

| 方法 | 参数 | 结果 |
|---|---|---|
| `health` | — | `{ok, parse, tasks, submissions, computePid}` |
| `conversation.list` | — | `{conversations: ConversationSummary[]}` |
| `conversation.create` | `{model?, thinkingLevel?}` | `{id}` |
| `conversation.submit` | `{id, requestId, text, command?, whenBusy?}` | `{submissionId, status}` |
| `conversation.abort` | `{id}` | `{ok: true}` |
| `conversation.setModel` | `{id, model, thinkingLevel}` | `{model, thinkingLevel}` |
| `conversation.subscribe` | `{id}` | `{subscriptionId}`，随后推送通知 |
| `conversation.unsubscribe` | `{subscriptionId}` | `{ok: true}` |
| `models.view` / `models.available` | — | 见 `server/src/routes/models.ts` 的同名接口 |
| `models.putProvider` / `models.deleteProvider` | 同 HTTP 版本 | 设置视图 |
| `models.setKey` / `models.clearKey` | `{providerId, apiKey?}` | 设置视图 |
| `models.setDefault` | `{model, thinkingLevel}` | 设置视图 |
| `models.test` | `{model, provider?, apiKey?}` | `{ok, text}` 或 `{ok:false, error}` |

通知（服务 → 客户端）：

| 通知 | 载荷 |
|---|---|
| `conversation.event` | `{subscriptionId, event: "snapshot", seq: 0, view}` |
| `conversation.event` | `{subscriptionId, event: "ops", seq, ops}` |
| `conversation.event` | `{subscriptionId, event: "end", kind}` |

语义与原 SSE 完全一致：订阅先给 `snapshot`（`seq: 0`），随后是逐条 `ops`（`seq` 连续递增），watch 结束给 `end`；服务重启后客户端重新订阅，拿到的新快照即当前状态。因为管道是有序的，不再需要心跳来检测断线——进程退出由 supervisor 观测。

错误码沿用 JSON-RPC：`-32602` 参数错误、`-32000` 业务错误（`data.kind` 细分，如 `no_model`、`model_unavailable`、`not_found`、`unknown_model`、`unsupported_thinking_level`）。

## 4. 资源加载

图表、看板、drawio 的 HTML 不再由服务托管 URL：

- compute 已把生成结果同时返回文本与 HTML（`tool.generate_chart` 等的 `charts[].html`）；
- 需要落盘的（看板、导出）由 compute 写入数据目录，路径通过结果返回；
- Go 侧读文件或用结果里的 HTML，经 `WebView.Page().LoadHTML` 或自定义 scheme 显示。

因此不再有 URL 令牌，也不需要为 Web view 保留任何 HTTP 监听。

## 5. 迁移步骤

1. `server/src/ipc/`：JSONL 读写（复用 `compute/rpc.py` 的分帧规则）、请求分发、通知推送；现有 `routes/*.ts` 的业务逻辑抽成与传输无关的函数。
2. `server/src/main.ts`：就绪记录改为 stdout 上的 `{"type":"ready","pid":…}`（不再有端口与令牌）；stdin 关闭即退出。
3. `desktop/internal/api`（2026-11-04 起拆为 `internal/jsonrpc`、`internal/service`、`internal/conversation`）：`Subscribe` 改为读 JSONL 通知；`Client` 的请求走同一管道；`Replica`/`ApplyOps` 不变。
4. `desktop/internal/supervisor`：去掉端口与令牌解析。
5. 更新 `docs/refactor/ui-protocol.md` 与 TS/Go 两侧类型；删除 `hono` 依赖与 `DW_TOKEN`/`DW_PORT`。
6. 测试：现有 `conversations`/`models`/`server` 用例改为走管道客户端（同一批断言），新增分帧与背压用例。

## 6. 与 pi 的差异（有意为之）

- pi 的 RPC 记录用扁平 `type` 字段，因为它的同一份事件流还要服务单向 JSON 模式；我们只有双向管道一种用途，用 JSON-RPC 2.0 可与 compute 链路共用实现。
- pi 有 `agent_settled` 这样的"确定不会再有自动工作"信号。我们的等价信号是 `pi.live.run` 消失且已有助手条目（`docs/refactor/ui-protocol.md` 里已有 `answered` 判定）；后续若加入重试/压缩的自动续跑，需要补一个同语义通知。
