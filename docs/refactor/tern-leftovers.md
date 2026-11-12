# Tern 打磨清单：已完成与未完成

状态：本项按「能做的做完、剩下的记录前提」收口。已完成 4 项都有用例；剩下的 3 项分别卡在上游字段（ttft）、GPU 验证环境（边缘模糊）与产品口味（无气泡），不阻塞其他工作。

对照 `docs/refactor/ui-redesign.md` 的 Tern 参照项，记下每一项现在的状态、证据与下一步。

## 已完成

| 项 | 做法 | 位置 |
|---|---|---|
| 当前动作状态行 | 有工具在跑时显示 `Running query_data…`（中文「正在执行 query_data…」），工具结束或思考/写正文阶段回到 `Working`；转圈与已用时不变 | `desktop/internal/app/chat_view.go`（`currentAction`/`statusLine`），用例 `TestStatusLineNamesTheRunningTool`、`TestStatusLineFallsBackToWorkingAfterTheToolFinishes` |
| 深色主题磨砂浓度 | 磨砂层不透明度按底色亮度分两档（浅色 0.62、深色 0.72）；深色底透出的浅色文字在 0.62 下会糊 | `desktop/internal/app/frost.go` |
| 上下文用量条 | 输入框上方一条细进度条，按最近一次回复的用量占模型窗口的比例；不知道窗口或不到 1% 时不画 | `desktop/internal/app/chat_view.go`（`contextMeter`） |
| 折叠行 | 一轮里连续的工具调用折成一行「Worked for …」，外观里可关 | `desktop/internal/app/chat_fold.go` |

## 未完成

### ttft（首字延迟）

现状：每轮末尾的元数据有 `in/out/cache/费用/tok/s`，没有 `ttft`。

证据：`@earendil-works/pi-ai` 的助手消息只有 `timestamp`（**请求开始**的毫秒时间戳）与 `durationMs`（到响应结束的总时长，见 `dist/types.d.ts` 第 398–405 行），没有首字时间字段；在整个 `node_modules/@earendil-works/*/dist` 里 grep `ttft` / `timeToFirstToken` 也无结果。界面的 `conversation.Usage` 来自这些条目，因此首字延迟不可能从现有字段反推（`timestamp + durationMs` 是结束时间）。

要补的话有三条路：

1. **server 记账**：在 `submit` 到第一个带正文的 delta 之间计时，把结果塞进同一条提交条目（新增 `ttftMs` 字段），桌面端再读进 `Usage`。需要确认 pi-durable 的 live 事件里能在提交前拿到「第一条 delta 的时间戳」。
2. **订阅 ops 计时**：server 在 `conversation.subscribe` 的同一路 `watch` 上解析 path 增量，找到第一条助手正文写入的时间；代价是要理解会话文档的路径结构，且多轮/中止/工具先行的边界要逐个定。
3. **等库支持**：上游加上 ttft 后只改 `usageOf` 与元数据行。

### 输入区边缘模糊

现状：整块磨砂（`frostShader`，统一 `BackdropBlur`），边缘没有羽化。要做的是给着色器加一个按到圆角距离衰减的遮罩，让模糊在边缘渐隐。

未做的原因：**无法在本机验证**。离屏渲染（`ui.Tester`）没有 GPU 加速，`frosted` 会走「近乎不透明纯色」的兜底分支，看不到着色器效果；真机验证需要 GPU 加速窗口 + 与参考图对比。

### 无气泡扁平风格

现状：只有用户消息有气泡底色（`Tok.UserBubble`），助手正文与工具行本来就是平的。若要彻底去掉气泡，需要新增一个外观选项（`prefs.Appearance` + 设置页 + 迁移默认值），属于产品口味决定，暂不动。

## 怎么验证这一页

- 上面「已完成」都有对应用例；运行 `cd desktop && go test ./internal/app`。
- 着色器相关的项只能在加速环境里看：`go run .`，切到深色配色，观察输入区背后的文字是否还清楚。
