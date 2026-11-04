# 界面通信协议（P2.3）

Go 桌面应用（`desktop/`）与 Bun agent 服务（`server/`）之间的协议。服务只给本机的 Go 界面用。界面连接或重连时先拿到对话的完整当前状态（快照），之后只收增量（ops）；不兼容旧版一次 POST 返回的 28 种 SSE 事件。

版本：`@earendil-works/pi-durable` / `pi-ai` / `chord` 1.5.0，`hono` 4.13.16，`github.com/egoist/mygo` v0.7.4。

| 内容 | TS（服务） | Go（界面） |
|---|---|---|
| 线上类型 | `server/src/protocol.ts` | `desktop/internal/api/client.go`、`subscribe.go` |
| 路由 | `server/src/routes/conversations.ts`、`server/src/routes/models.ts` | — |
| 由快照和 ops 还原视图 | chord `applyImmutable`（测试中使用） | `desktop/internal/api/delta.go`（`ApplyOps`）、`replica.go`（`Replica`、`State`） |
| 订阅与重连 | — | `desktop/internal/api/follow.go`（`Follow`） |
| 子进程 | `server/src/main.ts`（进程约定） | `desktop/internal/supervisor` |

## 1. 进程与鉴权

Go 应用把服务作为子进程启动：开发时是 `bun run server/src/main.ts`（从工作目录向上查找），发布时是 `bun build --compile` 编出的单文件，用 `-service` 参数或 `DW_SERVICE` 指定。

| 项 | 约定 |
|---|---|
| 环境变量 | `DW_TOKEN`：令牌，Go 每次启动应用时生成 32 字节随机数，base64url 编码（43 个字符），不写日志；`DW_PORT=0`；`DW_DATA_DIR`：与 `server/src/config.ts` 的默认目录相同（macOS `~/Library/Application Support/DataWhisper`，Windows `%APPDATA%\DataWhisper`，其他系统 `$XDG_DATA_HOME/datawhisper`，默认 `~/.local/share/datawhisper`）；可选 `DW_PYTHON`、`DW_COMPUTE_CWD` |
| 就绪 | stdout 第一行是 `{"type":"ready","port":N,"pid":N}`；其余 stdout、stderr 行都是日志，Go 端写入 `<数据目录>/logs/service.log` |
| 停止 | 关闭子进程的 stdin（服务读到 EOF 后正常退出），10 秒后仍未退出发 SIGTERM，再过 10 秒强杀。Windows 没有 SIGTERM，关闭 stdin 就是停止的办法 |
| 崩溃 | 运行中退出都算崩溃（退出码 1 表示存储失败）。Go 端退避后重启：0.5 秒起，每次翻倍，最多 15 秒；2 分钟内崩溃 5 次后不再重启，进入失败状态，界面提供“Retry”。重启后端口会变，令牌不变 |

鉴权：

- `/v1/*` 的请求都要带 `Authorization: Bearer <令牌>`，缺少或不对返回 401。
- Web view 资源（P7.2 的图表、画布、仪表盘页面和它们的脚本）不放在 `/v1` 下。WebKit 加载页面时不能带请求头，所以这些资源用 URL 参数 `?token=<令牌>` 鉴权；只带 Bearer 头、不带参数的请求返回 401；页面里引用的子资源也要带上参数。P0.3 已验证（`server/spike/src/spike4-server.ts` 的 `/chart.html` 和 `/static/plotly.min.js`）。`server/src` 目前还没有资源路由，P7.2 加第一个时按这条实现。
- 错误响应的 body 是 `{"error": string}`。

## 2. 接口

`:id` 是 `root` 或会话的数字 id（正整数）。`root` 是 pi-durable 保留的根会话（id 1，第一次访问时创建），新建的会话 id 从 2 开始。不存在或格式不对的 id 返回 404 `{"error":"not_found"}`。

| 方法 | 路径 | 请求 | 成功响应 | 错误 |
|---|---|---|---|---|
| GET | `/v1/health` | — | `{ok, scheduling, tasks, submissions, computePid}` | — |
| GET | `/v1/conversations` | — | `{conversations: ConversationSummary[]}`，新的在前 | — |
| POST | `/v1/conversations` | 可选：`{model?: {provider, modelId}, thinkingLevel?}` | 201 `{id}` | 400：未知模型，或模型不支持该思考强度 |
| GET | `/v1/conversations/:id/subscribe` | — | SSE，见第 3 节 | 404 |
| POST | `/v1/conversations/:id/submit` | `{requestId, text, whenBusy?: "steer" \| "followUp"}` | `{submissionId, status}` | 400、404、409 `no_model`、409 `model_unavailable` |
| PUT | `/v1/conversations/:id/model` | `{model: {provider, modelId}, thinkingLevel: <强度> \| null}` | `{model, thinkingLevel}` | 400、404 |
| POST | `/v1/conversations/:id/abort` | — | `{ok: true}` | 404 |
| — | `/v1/models/*` | 模型设置，见第 6 节 | | |

### 提交（submit）

- `requestId`：客户端生成的幂等键，在一个会话内唯一。同一个 `requestId` 再提交，返回同一个提交；它存在 SQLite 里，服务重启后也成立。Go 界面发送失败后，用同样的文本重发时沿用原来的 `requestId`，所以服务已收下的消息不会被收两次。
- `whenBusy`：对话正在运行时，`followUp`（默认）排到这一轮之后，`steer` 在下一个边界插入当前这一轮。
- `status` 即 pi-durable 的 `SubmissionRecord.status`：`queued`（在 `pi.inbox` 里排队）、`placed`（已写入对话，等待回答）、`done`（已回答）、`unanswered`（运行结束但没有回答，原因见 `pi.live.runFailure`）。
- 会话还没有模型时，服务在第一次提交时给它配上默认模型；一个可用模型都没有时返回 409 `{"error":"no_model"}`。会话的模型所属的提供商被删除或停用时返回 409 `{"error":"model_unavailable"}`。这两种 409 界面都要引导用户去模型设置（Go：`api.ErrNoModel`、`api.ErrModelUnavailable`）。

### 中止（abort）

撤回排队中的输入，中止当前运行，等它停下后返回。被中止的运行在视图里表现为 `pi.live.run` 消失、`pi.live.runFailure.reason` 为 `aborted`，它的输入以 `unanswered` 结束。空闲时调用也返回 `{ok: true}`。

### 会话列表

`ConversationSummary = {id, root, parent?: {conversationId, at}, lastEntryId: number | null, updatedAt: number | null}`。只列出无主会话，任务创建的子会话不列。`updatedAt` 是最新一条 entry 中最后一条消息的 `timestamp`（毫秒），没有就是 `null`。

pi-durable 1.5.0 的会话记录（`ConversationRecord`）只有 `id`、`parent`（分叉来源）和 `owner`（所属任务），没有标题、创建时间等元数据，所以列表暂时没有标题，界面先显示为“Chat <id>”。标题留到 P3.5，例如用一个应用自己的会话文档保存。

### 模型

- 新建会话不带 `model` 时用设置里的默认模型：保存的默认模型仍然可用就用它，否则用第一个可用模型；没有可用模型时会话不带模型创建，提交时返回 409 `no_model`。
- `PUT /:id/model` 从下一次模型请求起生效；`thinkingLevel: null` 表示清除，回到默认。响应里的 `thinkingLevel` 是实际生效的强度。
- 思考强度取值：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，以模型支持的为准（`/v1/models/available` 的 `thinkingLevels`）。
- 会话当前的模型在视图的 `docs["pi.agent"]` 里，界面从订阅中读取，不需要另外请求。

## 3. 订阅（SSE）

`GET /v1/conversations/:id/subscribe` 返回 `text/event-stream`：

| 事件 | data | 说明 |
|---|---|---|
| `snapshot` | `{seq: 0, view}` | 每个订阅的第一个事件；`view` 是 `conversation.watch()` 的当前值（第 4 节） |
| `ops` | `{seq, ops}` | `seq` 从 1 开始，每个事件加 1；`ops` 把 `seq - 1` 时的视图变成 `seq` 时的视图 |
| `end` | `{kind}` | watch 结束（服务关闭时为 `ended`，存储失败时为 `failed`），服务随后关闭这条流 |
| 注释行 `: ping` | — | 心跳，每 15 秒一行；不是事件 |

规则：

1. 每个订阅单独编号。SSE 的 `id:` 字段等于 `seq`。
2. 一个 `ops` 事件对应 watch 的一次回调；回调还在处理时到达的多次提交会合并成一次。没有 op 的回调不发事件。
3. watch 的 `failed` 回调（暂时算不出值）不发事件；之后的第一个值以 `["r", value]` 开头，照常应用即可。
4. 客户端遇到以下情况时重新订阅：`seq` 不连续、应用 op 出错、收到 `end`、连接断开、45 秒内没收到任何字节（心跳也算）。服务不支持 `Last-Event-ID` 续传，重连一律从新快照开始，客户端不用保存任何游标。
5. 服务每 15 秒写一次心跳；写入失败说明对方已经断开，服务停止这个 watch。

断线重连后界面状态与服务端一致，已用测试验证：TS 端 `server/test/conversations.test.ts` 用 chord 的 `applyImmutable` 还原一次流式回复，结果与重新订阅拿到的快照相等；Go 端 `desktop/live_test.go` 的 `TestLiveReplicaMatchesTheService` 用 `ApplyOps` 还原，与新快照的 JSON 逐字节相等，服务被 SIGKILL 杀掉、重启后拿到的快照也与它相等。

Go 端的 `api.Follow` 实现了上述重连：退避从 250 毫秒开始，每次翻倍，最多 5 秒，收到快照后重置；会话不存在（404）时停止。服务重启后端口会变，界面停掉旧的 `Follow`，用新端口重新订阅。

### ops

`ops` 是 chord `delta.Op` 的数组，原样转发 `watch()` 回调里的 ops。path 是由对象键（字符串）和数组下标（整数）组成的数组。

| op | 形式 | 含义 |
|---|---|---|
| `r` | `["r", value]` | 替换整个视图 |
| `s` | `["s", path, value]` | 设置 path 处的值；对象可新增键；数组下标等于长度时为追加 |
| `d` | `["d", path]` | 删除：对象删除该键；数组删除该下标的元素，后面的元素前移 |
| `a` | `["a", path, text]` | 在 path 处的字符串末尾追加 text（流式回复用它） |
| `t` | `["t", path, n]` | 去掉 path 处字符串开头的 n 个 UTF-16 码元（即 JS 的 `slice(n)`） |
| `p` | `["p", path, start, remove, items]` | 数组 splice：从 start 起删除 remove 个元素，再插入 items；path 可以是 `[]` |
| `m` | `["m", path, perm]` | 数组重排：`new[i] = old[perm[i]]`，长度不变 |

线上传的是未压缩的 `Op`，不使用 chord `WireOp` 的压缩（`#` 定义路径编号、数字路径引用、省略路径的短元组）。一次流式回复实际用到 `s`、`p`、`d`、`a`（第 5 节）；`r`、`t`、`m` 也要能处理。Go 的 `ApplyOps` 实现了全部 7 种并有单测；op 格式不对时返回错误而不是 panic，客户端随即重新订阅。

## 4. 视图（ConversationView）

```
{
  conversation: {id, parent?: {conversationId, at}, owner?: {conversationId, taskId}},
  entries: EntryRecord[],     // 对话记录的一个窗口，按 id 升序
  before?: EntryId,           // 窗口前一条 entry 的 id；没有这个字段表示窗口从头开始
  docs: {"pi.agent", "pi.live", "pi.inbox", "pi.usage", "pi.provider"}   // 不存在的文档不出现
}
```

**entries 窗口**：一开始是最新的 50 条，之后只追加；超过 100 条时一次删掉最旧的，剩下 50 条（一个 `p` op）。所以界面不能把 `entries` 当作完整历史；有 `before` 就说明更早的记录不在窗口里。加载更早历史的接口（pi-durable 的 `Conversation.entries()` 分页）留到 P3.5、P7.1。

**EntryRecord**：`{id, conversationId, kind, model?: Message[], data?, head?, edits?, byTaskId?}`，`byTaskId` 是写入这条 entry 的任务。各 kind：

| kind | model | 界面怎么用 |
|---|---|---|
| `pi.user` | `[UserMessage]`，`content` 是字符串或内容块 | 用户消息 |
| `pi.assistant` | `[AssistantMessage]`，`content` 由 `text`、`thinking`、`toolCall` 块组成 | 回复正文、思考过程、工具调用 |
| `pi.tool-result` | `[ToolResultMessage]`；`data.diagnostics` 是结构化诊断 | 工具结果 |
| `pi.system` | `[SystemMessage]`，内容为空 | 提示或工具集变化（`configure`），不显示 |
| `pi.reset` | 没有，或带交接文本的 `[UserMessage]` | 新上下文的开始 |
| `pi.compaction` | `[UserMessage]`，内容是摘要；`data.reason` | 压缩摘要 |

**docs**：

- `pi.live`（`LiveState`），当前运行的展示状态：
  - `run`：只在运行中存在，判断“忙”就看它。`taskId` 是当前生成任务，`inputs` 是这次运行的提交 id，`turns` 是已用的工具轮数。
  - `generation`：当前这次模型请求。`attempt` 是第几次尝试；`message` 是流式中的部分回复（pi-ai 的 `AssistantMessage`），新文本用 `a` op 追加到 `message.content[i].text`；`retry: {at, error}` 表示正在退避；`deferred` 表示在轮询。
  - `tools`：当前工具轮的调用，按调用顺序：`{callId, name, status: "pending" | "running" | "done", output?, droppedBytes?, droppedLines?, details?, diagnostics?, taskId?, unoffered?, entry?}`，`output` 是运行中的输出。`nestedTools` 是工具内部发起的嵌套调用。
  - `compactions`、`compactionFailure`：后台压缩的状态和最近一次失败。
  - `runFailure`：最近一次没有回答就结束的运行，`{taskId, inputs, reason, detail?}`；`reason` 是 `model_error`、`no_model`、`aborted`、`reset`、`faulted`、`orphaned`、`interrupted`、`restart_limit`、`nothing_to_answer`、`turn_limit` 之一。下一次运行开始时清除。
- `pi.inbox`：`{items: [...]}`，排队等待边界的提交：`{id, mode: "steer" | "followUp", content, entry?}` 或 `{id, mode: "write", entry}`。
- `pi.agent`（`AgentState`）：会话保存的选择，`model?: {provider, modelId}`、`thinkingLevel?`、`extensions?`、`tools?`、`modelTools?`、`instructions?`、`cwd?`、`maxTurns?`。界面显示其中的模型和思考强度。
- `pi.usage`：`{models: {"<provider>/<modelId>": Usage}, tools: {"<工具名>": Usage}}`，`Usage = {input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost: {input, output, cacheRead, cacheWrite, total, totalFromProvider?}}`。
- `pi.provider`：`{sessionId}`，发给提供商的会话标识，界面不用。

**聊天行**（Go 的 `api.Replica.State()`，P7.1 在此基础上扩展）：先按 `entries` 的顺序生成用户消息、工具调用（`→ 名称 参数`）、回复正文、工具结果（`← 结果`）；再加上 `pi.live.tools` 里还在运行的工具和 `pi.live.generation.message` 里的流式回复。流式回复的行键是 `g<run.taskId>`，回复提交后，`pi.assistant` entry 的 `byTaskId` 就是同一个任务 id，所以同一行从 `markdown.Stream` 切换到 `markdown.View`，不会因为 entries 窗口滑动而错位。

## 5. 一次回复的实录

2026-11-04 用 `server/test/support/stub-service.ts`（服务加进程内假模型）录制，长行有截断：

```
不带令牌的请求                                              → 401
POST /v1/conversations {}                                   → 201 {"id":2}
POST /v1/conversations/2/submit {"requestId":"doc-1",…}     → {"submissionId":9,"status":"placed"}
回复结束后用同一个 requestId 再提交                         → {"submissionId":9,"status":"done"}
GET  /v1/conversations                                      → {"conversations":[{"id":2,"root":false,"lastEntryId":11,"updatedAt":1793760037926}]}
GET  /v1/conversations/99/subscribe                         → 404 {"error":"not_found"}
PUT  /v1/conversations/2/model {"model":{"provider":"custom-stub","modelId":"stub-reasoner"},"thinkingLevel":"high"}
                                                            → {"model":{"provider":"custom-stub","modelId":"stub-reasoner"},"thinkingLevel":"high"}
```

```
event: snapshot
data: {"seq":0,"view":{"conversation":{"id":2},"entries":[],"docs":{"pi.agent":{"model":{"provider":"custom-stub","modelId":"stub-chat"}},"pi.live":{},"pi.inbox":{"items":[]},"pi.provider":{"sessionId":"01a1a46e-…"},"pi.usage":{"models":{},"tools":{}}}}}

event: ops
data: {"seq":1,"ops":[["s",["docs","pi.live","run"],{"taskId":10,"inputs":[9],"turns":0,"first":8}],["p",["entries"],0,0,[{"model":[{"role":"user","content":"Summarize the data","timestamp":1793760037872}],"kind":"pi.user","id":8,"conversationId":2}]]]}
data: {"seq":2,"ops":[["s",["docs","pi.live","generation"],{"attempt":1}]]}
data: {"seq":3,"ops":[["s",["docs","pi.live","generation","message"],{"role":"assistant","content":[{"type":"text","text":"## Hello\n\nThis is a **streamed** mar"}],…,"stopReason":"pending",…}]]}
data: {"seq":4,"ops":[["a",["docs","pi.live","generation","message","content",0,"text"],"kdown reply from the stub (req"]]}
…                                                            （seq 5–7 同样是 a）
data: {"seq":8,"ops":[["d",["docs","pi.live","run"]],["d",["docs","pi.live","generation"]],["s",["docs","pi.usage","models","custom-stub/stub-chat"],{"input":101,"output":20,…,"totalTokens":121,…}],["p",["entries"],1,0,[{"model":[{"role":"assistant",…}],"kind":"pi.assistant","id":11,"conversationId":2,"byTaskId":10}]]]}
data: {"seq":9,"ops":[["s",["docs","pi.agent","model"],{"provider":"custom-stub","modelId":"stub-reasoner"}],["s",["docs","pi.agent","thinkingLevel"],"high"]]}
```

回复用了 8 个 `ops` 事件（seq 1–8），第 9 个是切换模型。seq 8 提交的回复 `byTaskId` 为 10，与 seq 1 的 `run.taskId` 相同。9 个事件的 op 用量：`s` 6（其中 2 个来自切换模型）、`a` 4、`p` 2、`d` 2。

## 6. 模型设置接口（P3.1）

全部路由列在 `server/src/routes/models.ts` 的文件头，请求体类型见 `server/src/models/service.ts`。API key 只能写入，任何响应都不返回 key。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 设置视图（提供商、默认模型、各提供商认证来源）、内置提供商 id、自定义地址预设 |
| GET | `/v1/models/available` | 当前可用的聊天模型（已启用且认证齐全的提供商）：`{models: [{provider, id, name, contextWindow, maxTokens, reasoning, vision, thinkingLevels}]}` |
| PUT / DELETE | `/v1/models/providers/:id` | 新建或替换提供商（`ProviderSettings`，body 里的 id 要与 URL 一致）／删除提供商和它的 key |
| PUT / DELETE | `/v1/models/providers/:id/key` | 写入 `{apiKey}`／删除 key |
| PUT | `/v1/models/default` | `{model: ModelRef \| null, thinkingLevel: <强度> \| null}` |
| POST | `/v1/models/test` | `{model, provider?, apiKey?}`：通过真实提供商发一次很小的请求，可以测试未保存的设置 → `{ok: true, text}` 或 `{ok: false, error}` |

输入不合法返回 400 `{error}`。Go 客户端目前只封装了 `AvailableModels`（设置页的占位内容用到），其余在 P7.4 做设置界面时补上。

## 7. 类型对照

| 线上类型 | TS（`server/src/protocol.ts`） | Go（`desktop/internal/api`） |
|---|---|---|
| snapshot / ops / end 事件 | `SnapshotEvent`、`OpsEvent`、`EndEvent` | `Event`（`Name`、`Seq`、`View`、`Ops`、`Kind`） |
| 提交 | `SubmitRequest`、`SubmitResponse` | `SubmitRequest`、`SubmitResponse` |
| 会话列表 | `ConversationSummary`、`ConversationListResponse` | `ConversationSummary` |
| 新建会话 | `CreateConversationRequest`、`CreateConversationResponse` | `CreateConversationRequest`（返回 id） |
| 切换模型 | `SetModelRequest`、`AgentModelResponse` | `SetModelRequest`、`AgentModelResponse` |
| 模型引用 | pi-durable `ModelRef` | `ModelRef` |
| 错误 | `ErrorResponse` | `*Error`；`errors.Is` 匹配 `ErrNotFound`、`ErrNoModel`、`ErrModelUnavailable` |
| 视图 | pi-durable `ConversationView`、`EntryRecord`、`LiveState`、`InboxState`、`AgentState`、`UsageState` | 解码后的 JSON（`map[string]any`），由 `Replica.State()` 推导出 `State`、`Message` |

Go 端没有逐个照搬 pi-durable 的视图类型，而是保留 JSON 树、只读取界面用到的字段（第 4 节）。这样 pi-durable 往视图里加字段时，增量照样能应用，快照与副本照样相等。
