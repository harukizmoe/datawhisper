# 界面通信协议（P2.3，传输已改为 stdio）

Go 桌面应用（`desktop/`）与 Bun agent 服务（`server/`）之间的协议。服务是 Go 启动的子进程，两侧通过**子进程的 stdin/stdout 上 JSONL 分帧的 JSON-RPC 2.0** 通信：没有端口、没有令牌、没有网络面。界面连接或重连时先拿到对话的完整当前状态（快照），之后只收增量（ops）；不兼容旧版一次 POST 返回的 28 种 SSE 事件。

传输决策与理由见 `docs/refactor/ui-transport.md`；本文只写语义。

版本：`@earendil-works/pi-durable` / `pi-ai` / `chord` 1.5.0，`github.com/egoist/mygo` v0.7.4。

| 内容 | TS（服务） | Go（界面） |
|---|---|---|
| 分帧与分发 | `server/src/ipc/{framing,rpc,methods,attach}.ts` | `desktop/internal/api/client.go`、`subscribe.go` |
| 线上类型 | `server/src/protocol.ts` | `desktop/internal/api/client.go`、`subscribe.go` |
| 业务 | `server/src/conversations/service.ts`、`server/src/models/service.ts` | — |
| 由快照和 ops 还原视图 | chord `applyImmutable`（测试中使用） | `desktop/internal/api/delta.go`（`ApplyOps`）、`replica.go`（`Replica`、`State`） |
| 重连 | — | `desktop/internal/api/follow.go`（`Follow`） |
| 子进程 | `server/src/main.ts`（进程约定） | `desktop/internal/supervisor` |

## 1. 进程、分帧与生命周期

Go 应用把服务作为子进程启动：开发时是 `bun run server/src/main.ts`（从工作目录向上查找），发布时是 `bun build --compile` 编出的单文件，用 `-service` 参数或 `DW_SERVICE` 指定。

| 项 | 约定 |
|---|---|
| 环境变量 | `DW_DATA_DIR`（macOS `~/Library/Application Support/DataWhisper`，Windows `%APPDATA%\DataWhisper`，其他系统 `$XDG_DATA_HOME/datawhisper`，默认 `~/.local/share/datawhisper`）；可选 `DW_PYTHON`、`DW_COMPUTE_CWD` |
| 就绪 | stdout 第一行是 `{"type":"ready","pid":N}`，之后 stdout 只有 JSON-RPC 记录 |
| 日志 | stderr 与其余诊断行都是日志，Go 端写入 `<数据目录>/logs/service.log` |
| 分帧 | 一条记录一个 JSON 对象 + `\n`。只按 LF 切分：`U+2028`/`U+2029` 在 JSON 字符串里合法，不能当记录边界（Node 的 `readline` 不适用） |
| 背压 | 写方串行写出并等写完再写下一行；读方必须持续消费，否则服务端阻塞 |
| 关联 | 请求可带 `id`，响应原样回带；处理是异步的，客户端按 `id` 关联，不依赖顺序 |
| 停止 | 关闭子进程的 stdin（服务读到 EOF 后正常退出），10 秒后仍未退出发 SIGTERM，再过 10 秒强杀。Windows 没有 SIGTERM，关闭 stdin 就是停止的办法 |
| 崩溃 | 运行中退出都算崩溃（退出码 1 表示存储失败）。Go 端退避后重启：0.5 秒起，每次翻倍，最多 15 秒；2 分钟内崩溃 5 次后不再重启，进入失败状态，界面提供"Retry"。重启后是新的管道，客户端重建连接并重新订阅 |

错误码沿用 JSON-RPC：`-32700` 解析失败、`-32600` 请求非法、`-32601` 未知方法、`-32602` 参数非法、`-32603` 内部错误；业务错误用 `-32000`，细分在 `data.kind`。

## 2. 方法

`:id` 是 `root` 或会话的数字 id（正整数）。`root` 是 pi-durable 保留的根会话（id 1，第一次访问时创建），新建的会话 id 从 2 开始。不存在或格式不对的 id 报 `-32000` `data.kind = "not_found"`。

| 方法 | 参数 | 结果 | 错误 |
|---|---|---|---|
| `health` | — | `{ok, scheduling, tasks, submissions, computePid}` | — |
| `conversation.list` | — | `{conversations: ConversationSummary[]}`，新的在前 | — |
| `conversation.create` | 可选 `{model?, thinkingLevel?}` | `{id}` | `-32602`：未知模型，或模型不支持该思考强度 |
| `conversation.subscribe` | `{id}` | `{subscriptionId}`，随后推送通知（第 3 节） | `not_found` |
| `conversation.unsubscribe` | `{subscriptionId}` | `{ok: true}` | `-32602` |
| `conversation.submit` | `{id, requestId, text, command?, whenBusy?}` | `{submissionId, status}` | `-32602`、`not_found`、`no_model`、`model_unavailable` |
| `conversation.setModel` | `{id, model: {provider, modelId}, thinkingLevel: <强度> \| null}` | `{model, thinkingLevel}` | `-32602`、`not_found` |
| `conversation.abort` | `{id}` | `{ok: true}` | `not_found` |
| `usage.summary` | — | `harness.usage()` 的汇总 | — |
| `models.*` | 见第 6 节 | | |

### 提交（submit）

- `requestId`：客户端生成的幂等键，在一个会话内唯一。同一个 `requestId` 再提交，返回同一个提交；它存在 SQLite 里，服务重启后也成立。Go 界面发送失败后，用同样的文本重发时沿用原来的 `requestId`，所以服务已收下的消息不会被收两次。
- `command`：斜杠命令名（不含 `/`）。给出时本轮按命令执行，并解锁该命令的输出类工具。
- `whenBusy`：对话正在运行时，`followUp`（默认）排到这一轮之后，`steer` 在下一个边界插入当前这一轮。
- `status` 即 pi-durable 的 `SubmissionRecord.status`：`queued`（在 `pi.inbox` 里排队）、`placed`（已写入对话，等待回答）、`done`（已回答）、`unanswered`（运行结束但没有回答，原因见 `pi.live.runFailure`）。
- 会话还没有模型时，服务在提交时给它配上默认模型；一个可用模型都没有时报 `no_model`。会话的模型所属的提供商被删除或停用时报 `model_unavailable`。这两种情况界面都要引导用户去模型设置（Go：`api.ErrNoModel`、`api.ErrModelUnavailable`）。
- 提交前服务还会写入本轮上下文（消息、命令、数据源状态、关键词发现结果），并按 `server/src/tools/exposure.ts` 的算法重设本轮 `modelTools`。这一步会产生一条 `pi.system` 位置标记，界面渲染时应跳过。

### 中止（abort）

撤回排队中的输入，中止当前运行，等它停下后返回。被中止的运行在视图里表现为 `pi.live.run` 消失、`pi.live.runFailure.reason` 为 `aborted`，它的输入以 `unanswered` 结束。空闲时调用也返回 `{ok: true}`。

### 会话列表

`ConversationSummary = {id, root, parent?: {conversationId, at}, lastEntryId: number | null, updatedAt: number | null}`。只列出无主会话，任务创建的子会话不列。`updatedAt` 是最新一条 entry 中最后一条消息的 `timestamp`（毫秒），没有就是 `null`。

pi-durable 1.5.0 的会话记录（`ConversationRecord`）只有 `id`、`parent`（分叉来源）和 `owner`（所属任务），没有标题、创建时间等元数据，所以列表暂时没有标题，界面先显示为"Chat <id>"。标题留到 P7.1，用一个应用自己的会话文档保存。

### 模型

- 新建会话不带 `model` 时用设置里的默认模型：保存的默认模型仍然可用就用它，否则用第一个可用模型；没有可用模型时会话不带模型创建，提交时报 `no_model`。
- `conversation.setModel` 从下一次模型请求起生效；`thinkingLevel: null` 表示清除，回到默认。响应里的 `thinkingLevel` 是实际生效的强度。
- 思考强度取值：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，以模型支持的为准（`models.available` 的 `thinkingLevels`）。
- 会话当前的模型在视图的 `docs["pi.agent"]` 里，界面从订阅中读取，不需要另外请求。

## 3. 订阅（通知）

`conversation.subscribe {id}` 返回 `{subscriptionId}`，之后服务推送 `conversation.event` 通知：

| 通知参数 | 说明 |
|---|---|
| `{subscriptionId, event: "snapshot", seq: 0, view}` | 每个订阅的第一个事件；`view` 是 `conversation.watch()` 的当前值（第 4 节） |
| `{subscriptionId, event: "ops", seq, ops}` | `seq` 从 1 开始，每个事件加 1；`ops` 把 `seq - 1` 时的视图变成 `seq` 时的视图 |
| `{subscriptionId, event: "end", kind}` | watch 结束（服务关闭时为 `ended`，存储失败时为 `failed`） |

规则：

1. 每个订阅单独编号。同一时刻可能有多个订阅，通知按管道顺序到达，客户端按 `subscriptionId` 分发。
2. **快照可能先于 `subscribe` 的响应到达管道**：服务在返回前已写出快照。客户端必须缓存"还没有对应订阅的响应"的通知，拿到 `subscriptionId` 后按序补交，不能丢弃。
3. 一个 `ops` 通知对应 watch 的一次回调；回调还在处理时到达的多次提交会合并成一次。没有 op 的回调不发通知。
4. watch 的 `failed` 回调（暂时算不出值）不发通知；之后的第一个值以 `["r", value]` 开头，照常应用即可。
5. 客户端遇到以下情况时重新订阅：`seq` 不连续、应用 op 出错、收到 `end`、管道关闭。服务不支持续传，重连一律从新快照开始，客户端不用保存任何游标。
6. `conversation.unsubscribe` 停止 watch 且**不**发 `end`。服务停止时先给所有订阅发 `end`，再关闭。
7. 管道本身是有序可靠的，所以不再需要心跳：进程消失由 supervisor 观测。

断线重连后界面状态与服务端一致，已用测试验证：TS 端 `server/test/conversations.test.ts` 用 chord 的 `applyImmutable` 还原一次流式回复，结果与重新订阅拿到的快照相等；Go 端 `desktop/live_test.go` 的 `TestLiveReplicaMatchesTheService` 用 `ApplyOps` 还原，与新快照的 JSON 逐字节相等，服务被 SIGKILL 杀掉、重启后拿到的快照也与它相等。

Go 端的 `api.Follow` 实现了上述重连：退避从 250 毫秒开始，每次翻倍，最多 5 秒，收到快照后重置；会话不存在时报 `not_found` 并停止。服务重启后是新管道，界面停掉旧的 `Follow`，用新连接重新订阅。

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

2026-11-04 用 `server/test/support/stub-service.ts`（服务 + 进程内假模型）经管道录制，长行有截断：

```
→ {"id":"1","method":"conversation.create","params":{}}                ← {"id":"1","result":{"id":2}}
→ {"id":"2","method":"conversation.subscribe","params":{"id":2}}       ← {"id":"2","result":{"subscriptionId":1}}
→ {"id":"3","method":"conversation.submit","params":{"id":2,"requestId":"doc-1","text":"Summarize the data"}}
                                                                       ← {"id":"3","result":{"submissionId":10,"status":"placed"}}
回复结束后用同一个 requestId 再提交                                     ← {"id":"4","result":{"submissionId":10,"status":"done"}}
→ {"id":"5","method":"conversation.setModel","params":{"id":2,"model":{"provider":"custom-stub","modelId":"stub-reasoner"},"thinkingLevel":"high"}}
                                                                       ← {"id":"5","result":{"model":{"provider":"custom-stub","modelId":"stub-reasoner"},"thinkingLevel":"high"}}
```

同一轮的通知（`method: "conversation.event"`，共 6 条）：

```
{"method":"conversation.event","params":{"subscriptionId":1,"event":"snapshot","seq":0,"view":{"conversation":{"id":2},"entries":[],"docs":{"pi.agent":{"model":{"provider":"custom-stub","modelId":"stub-chat"}},"pi.live":{},"pi.inbox":{"items":[]},"pi.provider":{"sessionId":"01a1a5db-…"},"pi.usage":{"models":{},"tools":{}}}}}}
{"method":"conversation.event","params":{"subscriptionId":1,"event":"ops","seq":1,"ops":[["s",["docs","pi.agent","modelTools"],[]]]}}
{"method":"conversation.event","params":{"subscriptionId":1,"event":"ops","seq":2,"ops":[["s",["docs","pi.live","run"],{"taskId":11,"inputs":[10],"turns":0,"first":9}],["p",["entries"],0,0,[{"model":[{"role":"user","content":"Summarize the data","timestamp":1793783983619}],"kind":"pi.user","id":9,…}]]]}}
…                                                          （seq 3–4 是 generation 的开始与 `a` 追加流式文本）
{"method":"conversation.event","params":{"subscriptionId":1,"event":"ops","seq":5,"ops":[["d",["docs","pi.live","run"]],["d",["docs","pi.live","generation"]],["s",["docs","pi.usage","models","custom-stub/stub-chat"],{"input":101,"output":20,…,"totalTokens":121,"cost":{…}}],["p",["entries"],2,0,[{"model":[{"role":"assistant",…}],"kind":"pi.assistant",…}]]]}}
```

注意 seq 1 的 `["s",["docs","pi.agent","modelTools"],[]]`：提交前三步（写本轮上下文 → 收敛工具集 → `configure`）在这一轮没有可用工具，所以先把 `modelTools` 置空。有工具时会列出本轮要给模型的工具名。

## 6. 模型设置接口（P3.1）

方法表在 `server/src/ipc/methods.ts`（`models.*`），参数类型见 `server/src/models/service.ts`。API key 只能写入，任何响应都不返回 key。

| 方法 | 参数 | 结果 |
|---|---|---|
| `models.view` | — | 设置视图（提供商、默认模型、各提供商认证来源）、内置提供商 id、自定义地址预设 |
| `models.available` | — | `{models: [{provider, id, name, contextWindow, maxTokens, reasoning, vision, thinkingLevels}]}` |
| `models.discover` | `{baseUrl, apiKey?}` | `{models: [{id, name, contextWindow, maxTokens, reasoning, vision?, inferred?}]}`：读 `<baseUrl>/models`；端点不报告上限时填保守默认值并标 `inferred` |
| `models.putProvider` / `models.deleteProvider` | `ProviderSettings`（顶层字段，不是嵌套的 `provider`）/ `{id}` | 设置视图 |
| `models.setKey` / `models.clearKey` | `{providerId, apiKey}` / `{providerId}` | 设置视图 |
| `models.setDefault` | `{model: ModelRef \| null, thinkingLevel: <强度> \| null}` | 设置视图 |
| `models.test` | `{model, provider?, apiKey?}` | 通过真实提供商发一次很小的请求，可测未保存的设置 → `{ok: true, text}` 或 `{ok: false, error}` |

参数不合法报 `-32602`。Go 客户端（`desktop/internal/api/models.go`）已经封装上述全部方法，供 P7.4 的设置页使用；密钥只写在 `models.setKey` 的参数里，任何响应的 Go 类型都没有存放密钥的字段。

## 7. 类型对照

| 线上类型 | TS（`server/src/protocol.ts`） | Go（`desktop/internal/api`） |
|---|---|---|
| snapshot / ops / end 事件 | `SnapshotEvent`、`OpsEvent`、`EndEvent` | `Event`（`Name`、`Seq`、`View`、`Ops`、`Kind`） |
| 通知封装 | `ConversationEvent`（`conversation.event` 的 params） | `Subscribe` 内部解码 |
| 提交 | `SubmitRequest`、`SubmitResponse` | `SubmitRequest`、`SubmitResponse` |
| 会话列表 | `ConversationSummary`、`ConversationListResponse` | `ConversationSummary` |
| 新建会话 | `CreateConversationRequest`、`CreateConversationResponse` | `CreateConversationRequest`（返回 id） |
| 切换模型 | `SetModelRequest`、`AgentModelResponse` | `SetModelRequest`、`AgentModelResponse` |
| 模型引用 | pi-durable `ModelRef` | `ModelRef` |
| 错误 | `ErrorResponse` | `*Error`；`errors.Is` 匹配 `ErrNotFound`、`ErrNoModel`、`ErrModelUnavailable` |
| 视图 | pi-durable `ConversationView`、`EntryRecord`、`LiveState`、`InboxState`、`AgentState`、`UsageState` | 解码后的 JSON（`map[string]any`），由 `Replica.State()` 推导出 `State`、`Message` |

Go 端没有逐个照搬 pi-durable 的视图类型，而是保留 JSON 树、只读取界面用到的字段（第 4 节）。这样 pi-durable 往视图里加字段时，增量照样能应用，快照与副本照样相等。
