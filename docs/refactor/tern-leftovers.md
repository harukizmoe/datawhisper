# Tern 打磨清单：已完成与未完成

状态：本项按「能做的做完、剩下的记录前提」收口。除 ttft 外都已落地；ttft 卡在上游字段，不阻塞其他工作。

对照 `docs/refactor/ui-redesign.md` 的 Tern 参照项，记下每一项现在的状态、证据与下一步。

## 已完成

| 项 | 做法 | 位置 |
|---|---|---|
| 当前动作状态行 | 有工具在跑时显示 `Running query_data…`（中文「正在执行 query_data…」），工具结束或思考/写正文阶段回到 `Working`；转圈与已用时不变 | `desktop/internal/app/chat_view.go`（`currentAction`/`statusLine`），用例 `TestStatusLineNamesTheRunningTool`、`TestStatusLineFallsBackToWorkingAfterTheToolFinishes` |
| 深色主题磨砂浓度 | 磨砂层不透明度按底色亮度分两档（浅色 0.62、深色 0.72）；深色底透出的浅色文字在 0.62 下会糊 | `desktop/internal/app/frost.go` |
| 上下文用量条 | 输入框上方一条细进度条，按最近一次回复的用量占模型窗口的比例；不知道窗口或不到 1% 时不画 | `desktop/internal/app/chat_view.go`（`contextMeter`） |
| 折叠行 | 一轮里连续的工具调用折成一行「Worked for …」，外观里可关 | `desktop/internal/app/chat_fold.go` |
| 输入区磨砂与边缘羽化 | 卡片本身半透明 + 背景模糊（std 16 DIP），边缘按圆角矩形 SDF 在 14 DIP 内渐隐；卡片里再放一块实色内容板（圆角 18）承载输入与引用，所以文字只有卡片之外才透出 | `desktop/internal/app/frost.go`、`chat_view.go`（`frosted`、`composer`） |
| 输入区内部结构 | 状态区在卡片里：回复中左边转圈、已用时与正在做的事，下面一条细进度条，条下左边百分比、右边上下文窗口；回复中把这一轮提问引在实色板里，停止按钮是深色圆钮 | `desktop/internal/app/chat_view.go`（`cardStatus`、`quotedPrompt`、`stopButton`），用例 `TestComposerQuotesThePromptWhileReplying` |
| 无气泡扁平风格 | 用户消息去掉气泡与右对齐，与助手正文同一套排版，左侧一条 3 DIP 的 accent 竖线做区分；`userBubble` 主题令牌随之删除（19 个配色文件、`Tokens` 与默认值） | `desktop/internal/app/chat_view.go`、`internal/theme/` |

## 未完成

### ttft（首字延迟）

现状：每轮末尾的元数据有 `in/out/cache/费用/tok/s`，没有 `ttft`。

证据：`@earendil-works/pi-ai` 的助手消息只有 `timestamp`（**请求开始**的毫秒时间戳）与 `durationMs`（到响应结束的总时长，见 `dist/types.d.ts` 第 398–405 行），没有首字时间字段；在整个 `node_modules/@earendil-works/*/dist` 里 grep `ttft` / `timeToFirstToken` 也无结果。界面的 `conversation.Usage` 来自这些条目，因此首字延迟不可能从现有字段反推（`timestamp + durationMs` 是结束时间）。

要补的话有三条路：

1. **server 记账**：在 `submit` 到第一个带正文的 delta 之间计时，把结果塞进同一条提交条目（新增 `ttftMs` 字段），桌面端再读进 `Usage`。需要确认 pi-durable 的 live 事件里能在提交前拿到「第一条 delta 的时间戳」。
2. **订阅 ops 计时**：server 在 `conversation.subscribe` 的同一路 `watch` 上解析 path 增量，找到第一条助手正文写入的时间；代价是要理解会话文档的路径结构，且多轮/中止/工具先行的边界要逐个定。
3. **等库支持**：上游加上 ttft 后只改 `usageOf` 与元数据行。

### ttft（首字延迟）

现状：每轮末尾的元数据有 `in/out/cache/费用/tok/s`，没有 `ttft`。

证据：`@earendil-works/pi-ai` 的助手消息只有 `timestamp`（**请求开始**的毫秒时间戳）与 `durationMs`（到响应结束的总时长，见 `dist/types.d.ts` 第 398–405 行），没有首字时间字段；在整个 `node_modules/@earendil-works/*/dist` 里 grep `ttft` / `timeToFirstToken` 也无结果。界面的 `conversation.Usage` 来自这些条目，因此首字延迟不可能从现有字段反推（`timestamp + durationMs` 是结束时间）。

要补的话有三条路：

1. **server 记账**：在 `submit` 到第一个带正文的 delta 之间计时，把结果塞进同一条提交条目（新增 `ttftMs` 字段），桌面端再读进 `Usage`。需要确认 pi-durable 的 live 事件里能在提交前拿到「第一条 delta 的时间戳」。
2. **订阅 ops 计时**：server 在 `conversation.subscribe` 的同一路 `watch` 上解析 path 增量，找到第一条助手正文写入的时间；代价是要理解会话文档的路径结构，且多轮/中止/工具先行的边界要逐个定。
3. **等库支持**：上游加上 ttft 后只改 `usageOf` 与元数据行。

## 怎么验证这一页

- 上面「已完成」都有对应用例；运行 `cd desktop && go test ./internal/app`。
- 边缘模糊在真机（GPU 加速窗口）上验证过：临时给消息区垫一块高对比底色，截图能看到卡片四周的模糊渐隐；验证后已还原该临时改动。日常复核：`go run .`，拖动滚动让正文经过输入区下方，观察卡片边缘。
