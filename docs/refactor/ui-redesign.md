# 桌面端 UI 改版方案（草案）

> 状态：草案，待评审。范围：`desktop/` 的全部界面。
> 依据：`docs/refactor/screenshots/screenshot-*.png`（P7 阶段截图）、`desktop/*.go` 现状代码、server 已实现的 RPC 方法、
> MyGo v0.7.4 文档（`$GOMODCACHE/github.com/egoist/mygo@v0.7.4/docs/ui/`），以及对 Claude / ChatGPT 桌面版、
> Hex Threads、Databricks Genie、Positron Databot、Codex app 的调研。

---

## 0. 一句话

首版界面的问题分三层：**视觉地基没打**（字体、图标、层级）、**结构是工程师视角**（暴露服务状态、工具名、原始 JSON，
而不是问题、答案与证据）、**功能露出不足**（后端已有的知识库、技能、工作流、长任务、飞书、仪表盘管理在桌面端没有入口）。
改版目标是做成一个「可信的本地数据分析助手」：对话为主、过程可展开、每个数字可追溯、外观可由用户定制。

---

## 1. 现状诊断

### 1.1 视觉地基

| 问题 | 证据 | 影响 |
|---|---|---|
| 字体不受应用控制 | 应用没设 `Theme.Font`，继承系统 UI 字体（本机 GNOME 为 `Maple Mono NF CN Medium 12`）；只有 schema 与产物文本单独挑了等宽字体（`sources.go:147`） | 换一台机器观感就不同；用户无法单独设定界面与内容的字体 |
| 零图标 | `grep 'Icon(' desktop/*.go` 为 0 | 所有操作都是同权重文字按钮，无法扫读 |
| 无字号层级 | 只有默认、`FontSize(11/12)`、`Bold` 三档 | 页面标题、区块标题、正文、辅助文字分不开 |
| 色彩平、层次只靠 1px 边框 | 浅色主题灰底灰卡灰按钮；深色主按钮蓝偏暗，像禁用 | 没有焦点，整体「脏」 |
| 按钮无主次 | 标题栏 Rename / 模型 / 思考 / Data 同一种描边按钮（`chat.go:179`） | 不知道该点哪个 |
| 图表不跟主题 | 深色界面里嵌着浅色 plotly 图（`docs/refactor/screenshots/screenshot-chart.png`） | 割裂 |

### 1.2 信息架构

- **聊天标题栏过载**：标题、Rename、模型、思考强度、Data、服务状态挤一行。服务状态「● Ready」是进程状态，正常时不该常驻
  （异常已有 `banner`）。
- **消息流贴底**、用户气泡贴最右、回复限宽 760 靠左：消息少时上方大面积空白，视线来回横跨整个窗口。
- **侧边栏分组错位**：`Chats` 与 `App: Data / Settings` 并列；Data 是「当前对话的上下文」，不是全局导航。
- **数据面板以分栏挤压聊天**：打开后聊天列只剩一半（`docs/refactor/screenshots/screenshot-sources.png`），正文频繁折行。
- **设置页是调试面板**：按钮文案重复 provider 名（"Set key for Magpie local gateway"）以致溢出卡片；`process 484342`、
  `Credential backend: file` 放在主页面；用量全 0 仍占位；无分类导航；默认模型需要手动「保存」。

### 1.3 Agent 体验

- **工具调用像日志**：`workspace_status … ok [Details]`，用户读不懂 agent 在做什么、为什么。
- **没有数字出处**：后端质量闸门（数值溯源）已在工作，前端没有把「这个数来自哪条查询」呈现出来——这是数据分析产品的信任核心。
- **ask 卡片粗糙**：问题文字出现两次（`Bold` + `RadioGroup.Label`）；"Quick question"、"Send answer" 等文案硬编码未走 i18n。
- **输入区只有一行**：无附件、无 `+` 菜单、无换行；模型选择不在输入区。
- **消息无操作**：不能复制、重新生成、编辑重发、反馈。
- **无首页 / 空状态**：新对话是一片空白，引导靠模型自己 `ask_user`。

### 1.4 后端已有、桌面未接

| 后端 RPC | 桌面现状 |
|---|---|
| `knowledge.*`（约 19 个） | 未接 |
| `skill.list` | 只有斜杠补全，无技能浏览 |
| `workflow.runs.*`、`jobs.*` | 长任务 / 工作流不可见、不可取消 |
| `teams.*` | 子 agent 委派不可见 |
| `feishu.*` | 无设置入口 |
| `dashboard.create/update/refresh/remove` | 只接了 `list`、`exportHtml` |
| （缺） | 会话删除 / 搜索 / 置顶 / 归档——后端也没有，需新增 RPC |

---

## 2. 设计原则

1. **对话为主，过程逐层展开**：默认看结论；过程一层可见（工作摘要），原始数据两层内可达（SQL、结果表）。
2. **可追溯**：答案中的数字与图表能一键回到查询、表、行数；溯源失败的数字明确标记。
3. **状态安静**：正常时不打扰；忙时有状态行与停止；出错时给修复动作（重试 / 让 agent 修复）。
4. **危险动作要确认**：覆盖数据源、写文件、破坏性 SQL 需确认；只读查询直接执行。
5. **键盘优先**：命令面板与常用快捷键覆盖所有高频动作。
6. **外观属于用户**：主题、字体、密度、强调色可定制，且所有界面（含图表 web view、Markdown、代码高亮）同步生效。
7. **只用官方组件拼装**：遵守仓库约定，优先 MyGo 官方组件；缺的组件封装成本仓库内的小组件（见 §6）。

---

## 3. 信息架构与布局

### 3.1 三栏布局

```
┌─────────────┬────────────────────────────────┬────────────────────┐
│ 侧边栏       │  对话标题                   ⋯  │ 检查器（可收起）      │
│ [+ 新对话]   │                                │ [数据][产出物][运行]  │
│ 🔍 搜索  ⌘K │   ┌ 用户问题 ───────────┐       │                    │
│             │   └────────────────────┘       │ sales.xlsx         │
│ 今天         │  ▸ 已运行 2 条查询 · 1 张图 · 4s │ 3 表 · 1.2k 行      │
│  区域销售…   │  华东最高（270）¹ …             │ ▸ customers        │
│ 昨天         │  ┌ 图表卡片 ───────────┐        │ ▸ sales            │
│  …          │  │ [缩略图]      ⤢  ⬇ │        │                    │
│ ─────────── │  └────────────────────┘        │                    │
│ 📚 知识库    │  ⧉  ↻  ✎  👍 👎                │                    │
│ 🧩 技能      │ ┌────────────────────────────┐ │                    │
│ ⚙ 设置   ●  │ │ 📎 sales.xlsx ×             │ │                    │
│             │ │ 问点什么…                    │ │                    │
│             │ │ [+] [模型 ▾] [思考 ▾]    [↑] │ │                    │
└─────────────┴─┴────────────────────────────┴─┴────────────────────┘
```

- 侧边栏：宽 240–280，可拖动、可收起（⌘\）。
- 中间对话列：内容**居中**，最大宽度由外观设置决定（默认 760），用户消息与回复共用一条轴线。
- 检查器：右侧可收起的 `Split`，默认关闭；有新产出物 / 运行中任务时在标题栏 `⋯` 旁出现提示点。

### 3.2 侧边栏

- 顶部：新对话、搜索（打开命令面板的会话过滤）。
- 会话按时间分组：置顶 / 今天 / 昨天 / 7 天内 / 更早。悬停显示 `⋯`；右键菜单：重命名、置顶、删除。
- 底部固定：知识库、技能、设置；服务状态只是设置图标上的一个小点，异常时变色。
- Data 从侧栏移除，进入检查器。

### 3.3 对话页

**标题栏**：只留标题（单击即可就地重命名，`EditableText`）、检查器开关、`⋯` 菜单（重命名 / 导出报告 / 删除）。
模型与思考强度移到输入区。

**一轮（turn）的结构**：

1. 用户消息：浅色气泡，可复制、编辑重发。
2. **工具步骤卡片**（替代现在的逐行 toolRow，样式参考 Tern，见 §3.7）：
   - 每次工具调用一张卡片，默认展开、内容截断，不整体折叠：
     - 标题行：工具图标、工具名（强调色）、一句意图说明（如「查询各区域销售额」）；
     - 卡片上半部分：SQL / 参数，语法高亮；
     - 卡片下半部分：结果。表格结果显示前几行，文本结果只显示末尾若干行；
     - 截断处显示「前面还有 48 行 ⌃」「后面还有 37 行 ⌄」，点击展开，截断边缘渐隐；
     - 卡片底部：「✓ 完成 · 0.4s · 1,203 行」，失败时为红色「✕ 失败」。
   - 运行中的卡片底部显示进度动画。出错的卡片完整展开，提供「重试」「让 agent 修复」。
   - 一轮步骤很多时，可以把本轮所有卡片折叠成一行摘要「已运行 6 步 · 4.2s ⌄」。默认不折叠。
   - 思考内容（thinking）折叠为一行斜体灰字「思考 ›」，点开显示全文。
3. **回答正文**：`markdown.View/Stream`；数字出处以上标角标标出，点击弹出 `Popover`：查询、数据源、行数、跳到检查器。
4. **图表卡片**：对话流内显示静态缩略图（或固定高度的 web view）+ 标题 + 操作（全屏、导出 PNG/SVG/HTML、查看数据）。
   完整交互版在检查器「产出物」或全屏 `Modal` 中打开。
   理由：Linux 上 web view 的滚动事件先交给原生 UI（`web-view.md`），嵌在滚动聊天流里的交互图体验差。
5. **操作栏**：复制、重新生成、编辑、👍/👎；悬停时出现，最后一条常显。
6. **旁注（quality gate / system note）**：保持折叠，样式改为一行灰色小字 + 图标，不再用 Badge。

**ask 卡片**：问题只显示一次；选项做成可点的选项行（整行可点、带键盘编号 1–9）；自由回答与「发送」同行；
答完后卡片收起为「你选择了：xxx」并保留问题。文案全部进 i18n。

**输入区**：

- 多行 `TextArea`，按内容自动长高（1–8 行），Enter 发送、Shift+Enter 换行。
- 附件以 chip 显示在输入框上沿（`TokenField` 或自绘 chip）；支持拖放文件到整个对话区。
- 整体是大圆角容器（参考 Tern，§3.7）。占位文字写出能力提示：「问点什么 — / 命令 · @ 数据源」。
- 底部一排小标签：`+` 菜单（导入文件、连接数据库、引用知识库、选择技能）、模型、思考强度、权限（只读 / 可写，可写时淡黄底）、当前数据源。右侧是圆形发送按钮，运行时变成停止。
- 输入框上方：运行时显示状态行（动画图标、当前动作、已用时）；上沿一条细进度条，表示上下文用量。
- 忙碌时输入的消息作为浮动标签排队，可编辑、取消或改为插队，取代现在单独一行的排队 / 插队控件。

**首页 / 空状态**：居中问候 + 大输入框；下方三个入口卡：拖入 CSV / Excel、连接数据库、看示例；
导入数据后根据 schema 给出 3–4 个推荐问题。

### 3.4 检查器（当前对话的上下文）

| 标签 | 内容 |
|---|---|
| 数据 | 已挂载数据源（名称、表数、行数、是否参与分析开关）、schema 树（`Tree`）、表预览（`Table`）、导入 / 连接 |
| 产出物 | 本对话的图表、仪表盘、导出文件；点开在检查器内交互查看；仪表盘的新建 / 刷新 / 删除 |
| 运行 | 长任务（`jobs.*`）、工作流运行（`workflow.runs.*`）、子 agent（`teams.*`）：进度、日志摘要、取消 |

### 3.5 设置

左侧分类（`Sidebar` 或纵向 `Tabs`），右侧内容，**改动即时生效、即时保存**（去掉「Save default model」之类按钮）：

| 分类 | 内容 |
|---|---|
| 通用 | 语言、启动行为、数据目录 |
| 外观 | 见 §5 |
| 模型 | provider 卡片（名称、类型、地址、启用开关；次要操作收进 `⋯`：设置 key、编辑、删除、测试）；默认模型与思考强度 |
| 数据源 | 全局数据源、权限 |
| 知识库 | 分类、文件、条目、重建 embedding |
| 集成 | 飞书、MCP |
| 用量 | token 与费用（有数据时才显示图表，无数据给空状态） |
| 高级 | 服务进程、凭据后端、日志路径、打开日志 / 数据目录、重启服务 |

### 3.6 命令面板与快捷键

命令面板（⌘K / Ctrl+K）：搜会话、搜命令（新对话、切换主题、打开设置某页、导入数据…）、搜数据源。

| 快捷键 | 动作 |
|---|---|
| ⌘N | 新对话 |
| ⌘K | 命令面板 |
| ⌘\ | 开关侧栏 |
| ⌘⇧I | 开关检查器 |
| ⌘. | 停止当前回合 |
| ⌘, | 设置 |
| Esc | 关闭弹层 / 检查器 |

（Linux / Windows 上 ⌘ 换成 Ctrl。）

### 3.7 参考 Tern 的会话面板

Tern（Stencil 出品的终端加 agent 客户端）是用户日常在用、也认可的产品。2026-11-04 截取了它的会话面板，借鉴点如下：

| Tern 的做法 | 对应到 DataWhisper |
|---|---|
| 面板头部：类型标签（`Agent`）、运行状态点、会话标题（粗体）、工作目录与 git 分支（灰色，可截断）、右侧分栏图标 | 标题、当前数据源标签（如 `sales.xlsx`）、状态点；右侧是检查器开关和 `⋯` |
| 工具调用一张卡片：「图标 + 工具名（着色）+ 意图说明」作标题；卡片内命令高亮在上、输出在下，中间用细线分隔 | §3.3 的工具步骤卡片；SQL 在上，结果表或文本在下 |
| 长输出只显示一部分，用「48 earlier lines ⌃」「37 more lines ⌄」展开，截断边缘渐隐 | 结果表显示前几行，文本只显示末尾，不再用「Details」按钮二选一 |
| 卡片底部「✓ Done 0.0s」：绿色勾、灰色耗时 | 「✓ 完成 · 耗时 · 行数」 |
| 「Thought ›」：思考折叠为一行斜体灰字 | 同样处理 |
| 每轮末尾一行灰色小字元数据：`22:04 · in 257 · out 249 · cache 396K · ttft 2.3s · 62.9 tok/s` | 每轮末尾：时间 · tokens · 耗时 · 费用。默认显示，可在外观里关闭 |
| 输入框正上方的状态行：动画图标、`Working`、竖线、已用时 | 「正在查询… │ 12s」，停止按钮在输入框右侧 |
| 一条细进度条横在输入框上沿，标出上下文用量（`17%` … `1M`） | 同样显示上下文窗口用量 |
| 输入框：大圆角容器；占位文字直接写出能力（`/ commands · @ files`）；底部一排小标签：模型（带图标的下拉）、权限模式（淡黄底，提醒处于高权限）、git 分支（绿色）；右侧圆形主按钮，运行时变成停止 | 占位文字为「问点什么 — / 命令 · @ 数据源」；底部依次是模型、思考强度、权限（只读 / 可写，可写时淡黄底）、当前数据源；右侧圆形发送 / 停止按钮 |
| 运行中输入的消息作为浮动小标签停在面板右侧（排队），不占整行 | 替代现在单独一行的「排队 / 插队」控件：排队的消息显示为浮动标签，可点开编辑、取消或改为插队 |
| 会话面板右侧有一条圆角的竖向导航轨：轨上**每一道横线都是一条用户消息**，按它在整段对话中的位置比例排布（开头连续几条提问挨得很近，就叠成紧挨的几道）；当前视口所在的那条用强调色高亮 | 同样实现「用户消息导航轨」：刻度位置 = 该提问在内容总高度中的比例；点击刻度跳到那条提问；悬停时用 tooltip 显示提问的第一行；当前所在的提问用强调色高亮 |
| 一个窗口里可以并排多个会话面板，各有自己的输入框；没有焦点的面板，输入框收成一个显示会话标题的小标签 | P5 考虑：分屏并排两个对话，对比两种分析 |
| 视觉：全等宽字体（Maple Mono）、深色、边框对比很低、卡片大圆角（约 12）、卡片之间留白大；颜色只用于表达语义（工具名、成功、错误、代码高亮） | 与 §4 和 §5 一致：默认 Maple Mono NF CN、低对比边框、语义色克制 |
| 主题来自 omp 主题，有带实时预览的主题选择器 | 与 §5.1 的外观页实时预览一致 |

**和本方案原设计的取舍**：原设计是「整轮折叠成一行工作摘要」。现在改为 Tern 式：每张卡片默认可见，靠截断控制篇幅，整轮折叠作为可选操作。这样过程信息一直在眼前，更符合「可追溯」原则（§2）。

---

## 4. 视觉规范（默认主题）

| 项 | 规范 |
|---|---|
| UI 字体 | 默认 **Maple Mono NF CN**，由应用显式设定（`Theme.Font`），不再隐式继承系统；可在外观里单独改（§5.4） |
| buffer 字体 | 默认 **Maple Mono NF CN**，用于代码、SQL、schema、数据表、工具输出；与 UI 字体分开设定、各有字号；表格数字加 `FontFeatures("tnum")` |
| 字号层级 | 12 辅助 / 13 次要 / 14 正文 / 16 区块标题 / 20 页面标题 / 28 首页问候（随用户「字号」整体缩放） |
| 行高 | 界面 1.5；回答正文 1.7（等宽字体中英混排需要更松的行距）；buffer 1.5 |
| 间距 | 4 的倍数：控件内 8，块与块 12–16，区域之间 24–32（对应 `Theme.Spacing=4` 与 `t.Space(n)`） |
| 圆角 | 控件 8、卡片 12、气泡 16（对应 `Theme.Radius` 及其倍数） |
| 配色 | 默认主题见 §5.2；用户可换成 Catppuccin、Dracula 等开源配色 |
| 图标 | 内嵌 Lucide SVG（`ui.MustParseSVG` + `ui.Icon`），约 30 个；统一 16px（工具条 18px），线宽 1.75 |
| 中性色 | 4 级：背景 / 表面 / 悬停 / 边框；浅色背景接近白（不再整片中灰） |
| 语义色 | 1 个强调色 + 成功 / 警告 / 危险；状态词汇统一：运行中、完成、失败、待确认 |
| 层次 | 弹出层、菜单、图表卡片用轻阴影（`Shadow`）；普通分组靠间距而不是边框 |
| 动效 | 展开 / 折叠、检查器开合、toast：150–200ms（`ElementTransition`）；尊重「减少动效」 |

---

## 5. 外观与主题定制

用户可以自己设定外观，这是一等功能。需求有三条：

1. 外观模式支持暗、亮、跟随系统；
2. 配色可以用开源主题（Catppuccin、Dracula 等）；
3. UI 字体和 buffer 字体分开设定，默认都是 **Maple Mono NF CN**。

设计目标：**主题只是数据（JSON），不是代码**。加一套开源配色就是加一个文件。全界面同步生效，包括原生控件、回答正文、代码高亮和图表 web view。用户怎么调都不会把界面调到看不清，对比度有护栏。

### 5.1 设置项

位置：设置 → 外观。左侧是选项，右侧是**实时预览**。预览是一段迷你对话，包含用户气泡、工作摘要、回答、代码块、数据表、图表卡片和按钮。

| 分组 | 选项 | 取值 | 落到哪里 |
|---|---|---|---|
| 模式 | 外观模式 | 跟随系统 / 亮 / 暗 | `mygo.ThemeSource`，并决定用下面哪一套配色 |
| 配色 | 亮色配色、暗色配色（分别选） | 内置主题 + 用户导入的主题（§5.2） | 整套颜色 token |
| | 强调色 | 主题自带 / 主题调色板里的某个颜色（如 Catppuccin 的 14 个强调色）/ 自定义（`ColorPicker`） | `Accent*`、`Focus`、`Selection`、链接 |
| UI 字体 | 字体 | 默认 `Maple Mono NF CN`；也可选任意已安装字体（`ui.FontFamilies()`）或跟随系统 | `ui.Theme.Font`、`markdown.Theme.Font` |
| | 字号 | 12–18，默认 14 | `ui.Theme.FontSize`；字号层级按比例缩放 |
| | 字重 | Light / Regular / Medium（默认 Regular） | `FontWeight` |
| buffer 字体 | 字体 | 默认 `Maple Mono NF CN`；其余同上 | `markdown.Theme.CodeFont`、代码块、SQL、schema、数据表、工具输出 |
| | 字号 | 11–18，默认 13 | 上述区域 |
| | 字重 | 同上 | 同上 |
| | 行高 | 1.2–2.0，默认 1.5 | `markdown.Theme.CodeLineHeight`、表格行高 |
| | 连字（ligatures） | 开 / 关（默认关） | `FontFeatures("calt", "liga")`；表格数字始终 `tnum` |
| 正文 | 回答正文字体 | 跟随 buffer 字体（默认）/ 跟随 UI 字体 | `markdown.Theme.Font` |
| | 正文行高 | 1.4–2.0，默认 1.7 | `markdown.Theme.LineHeight` |
| 布局 | 界面风格 | Compact（默认）/ Islands | 窗口骨架，见下文「界面风格」 |
| | 密度 | 紧凑 / 标准 / 宽松 | `ui.Theme.Spacing` = 3 / 4 / 5 |
| | 圆角 | 方 / 标准 / 圆 | `ui.Theme.Radius` = 4 / 8 / 12 |
| | 对话宽度 | 窄 640 / 标准 760 / 宽 960 / 铺满 | 对话列 `MaxWidth` |
| | 用户消息样式 | 气泡 / 平铺 | 用户消息渲染 |
| 内容 | 代码高亮 | 跟随配色（默认）/ 指定某个主题的高亮 | `markdown.Theme.CodeColors`（`editor.Theme`） |
| | 图表 | 跟随配色（默认）/ 始终亮 / 始终暗 | 注入图表 web view 的模板 |
| | 图表色板 | 来自配色（默认）/ 色盲友好 | plotly / echarts 的 colorway |
| 无障碍 | 减少动效 | 跟随系统 / 开 / 关 | 所有 `Transition` 时长归零 |
| 管理 | 导入主题、打开主题目录、恢复默认 | JSON 文件 | `<dataDir>/themes/` |

**模式和配色的关系**

- 选「亮」或「暗」时，只用对应那一套配色。
- 选「跟随系统」时，两套都要选好，随系统切换。
- 一个主题家族有多个变体时，自动配对。例如 Catppuccin 的亮色是 Latte，暗色可选 Frappé、Macchiato 或 Mocha，默认 Mocha。用户也可以拆开，选两个不相干的主题。
- 只有暗色的主题（Dracula、Tokyo Night Night 等）只出现在「暗色配色」的列表里。

**界面风格：Compact 与 Islands**

| | Compact（默认，现在的样子） | Islands |
|---|---|---|
| 区域关系 | 侧栏、对话区、数据面板直接拼在一起，彼此之间用 1px 分隔线 | 每个区域是一座圆角「岛」，浮在更深（暗色）或更浅（亮色）一档的窗口底色上，岛与岛之间、岛与窗口边缘之间留出约 8 DIP 的间隙，不画分隔线 |
| 圆角 | 区域本身没有圆角，只有卡片、气泡有 | 岛的圆角约 12 DIP，与卡片一致 |
| 适合 | 小窗口、信息密度优先 | 大屏、喜欢层次分明的观感 |

实现要点：
- 窗口底色用新的 `canvas` 角色。配色可以在 `roles` 里指定，比如 Catppuccin 用 `crust`；没指定时由 `background` 推导，暗色往黑里压、亮色往文字色里混一点。
- 三个区域的外层容器在 Islands 下加上 `Margin`、`Radius`、`Clip`，并去掉相邻边框；岛内部的排版两种风格完全相同。
- 分栏拖动条（`Split`）落在岛与岛之间的间隙里，拖动行为不变。
- 和「密度」是两个独立的选项：Islands 加上紧凑密度，同样成立。

**UI 字体与 buffer 字体的分工**

借用 Zed 编辑器的说法：

- **UI 字体**：侧边栏、标题栏、按钮、菜单、设置、提示等界面外壳。
- **buffer 字体**：一切「内容数据」，即代码块、SQL、schema 树、数据表单元格、工具输出、日志。

回答正文属于内容，默认跟 buffer 字体，可以单独切换到 UI 字体。两种字体默认都是 Maple Mono NF CN，所以开箱就是你现在的观感。区别在于这是应用主动设定的，并且可以分别调整。

### 5.2 主题格式与内置主题

内置主题和用户主题用**同一种 JSON 格式**。内置主题通过 `go:embed` 打进二进制（`desktop/internal/theme/themes/*.json`），用户主题放在 `<dataDir>/themes/*.json`，id 相同时用户主题优先。

```json
{
  "id": "catppuccin-mocha",
  "name": "Catppuccin Mocha",
  "family": "catppuccin",
  "appearance": "dark",
  "license": "MIT",
  "source": "https://github.com/catppuccin/palette",
  "palette": {
    "rosewater": "#f5e0dc", "flamingo": "#f2cdcd", "pink": "#f5c2e7", "mauve": "#cba6f7",
    "red": "#f38ba8", "maroon": "#eba0ac", "peach": "#fab387", "yellow": "#f9e2af",
    "green": "#a6e3a1", "teal": "#94e2d5", "sky": "#89dceb", "sapphire": "#74c7ec",
    "blue": "#89b4fa", "lavender": "#b4befe",
    "text": "#cdd6f4", "subtext1": "#bac2de", "subtext0": "#a6adc8",
    "overlay2": "#9399b2", "overlay1": "#7f849c", "overlay0": "#6c7086",
    "surface2": "#585b70", "surface1": "#45475a", "surface0": "#313244",
    "base": "#1e1e2e", "mantle": "#181825", "crust": "#11111b"
  },
  "accents": ["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach",
              "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender"],
  "roles": {
    "background": "base", "sidebar": "mantle", "inspector": "mantle",
    "surface": "surface0", "surfaceHover": "surface1", "surfacePressed": "surface2",
    "border": "surface1", "text": "text", "textMuted": "subtext0",
    "accent": "mauve", "link": "blue", "selection": "overlay2/0.25", "focus": "lavender",
    "success": "green", "warning": "yellow", "danger": "red",
    "userBubble": "surface0", "codeBackground": "mantle"
  },
  "syntax": {
    "keyword": "mauve", "string": "green", "number": "peach", "comment": "overlay1",
    "function": "blue", "type": "yellow", "constant": "peach", "operator": "sky"
  },
  "chart": ["blue", "peach", "green", "red", "mauve", "teal", "yellow", "pink"]
}
```

**格式规则**

- `palette`：主题作者给的原始调色板，名称照抄上游，方便对照上游规范核对。
- `roles`：把语义角色映射到调色板名称，或直接写 `#hex`。`名称/0.25` 表示带透明度。
- `accents`：列出可以当强调色用的调色板名称，用户在设置里从中挑选。没有这个字段时只能用主题默认色或自定义色。
- `syntax` / `chart`：可以省略。省略时从 `roles` 推导：关键字和图表第一色用强调色，其余从调色板按色相取。
- 主题里没写的 `ui.Theme` 字段由推导规则补齐（§5.3）。所以新主题最少只需要 `palette` 加七八个核心 role。

**首批内置主题**（以各上游的官方规范为准，入库时逐个核对色值与许可证）：

| 家族 | 变体 | 亮 / 暗 | 上游 |
|---|---|---|---|
| DataWhisper（默认） | Light / Dark | 亮 + 暗 | 本仓库 |
| Catppuccin | Latte / Frappé / Macchiato / Mocha | Latte 亮，其余暗 | github.com/catppuccin/palette（MIT） |
| Dracula | Dracula / Alucard | Alucard 亮，Dracula 暗 | draculatheme.com/spec（MIT） |
| Nord | Nord | 暗（亮色另配） | nordtheme.com（MIT） |
| Gruvbox | Light / Dark | 亮 + 暗 | github.com/morhetz/gruvbox（MIT） |
| Tokyo Night | Night / Storm / Day | Day 亮，其余暗 | github.com/folke/tokyonight.nvim（Apache-2.0） |
| Rosé Pine | Dawn / Main / Moon | Dawn 亮，其余暗 | rosepinetheme.com（MIT） |
| Solarized | Light / Dark | 亮 + 暗 | ethanschoonover.com/solarized（MIT） |

- 每个内置主题保留 `license` 与 `source` 字段。「关于 → 第三方声明」列出所有配色的出处与许可证。
- 主题名称沿用上游原名，这是这些开源配色项目鼓励的用法。上游提供官方「端口（port）」规范的，遵守其角色约定，例如 Catppuccin 的 style guide 规定背景用 base、侧栏用 mantle、链接用 blue。

**以后的扩展**

- 用户放一个 JSON 进主题目录，在设置里点「重新加载主题」即可出现。
- 后续可以加转换器，把 VS Code / Zed 主题导入成本格式。先不做，见 §8。

### 5.3 推导与护栏

```
prefs（模式、亮/暗配色 id、强调色、字体、字号、密度…）
   + 主题 JSON（palette、roles、syntax、chart）
        │
        ▼  theme.Resolve(scheme, dark, accent, fonts)   // 纯函数，单测覆盖
  ui.Theme         → 原生控件
  markdown.Theme   → 回答正文、代码块（Font / CodeFont / LineHeight / CodeLineHeight / CodeColors）
  appTokens        → 本应用扩展：侧栏、检查器背景、用户气泡、工作摘要、出处角标、卡片阴影
  chartTheme       → 图表 web view（CSS 变量 + plotly/echarts 模板 + colorway）
```

- **补齐缺失字段**：主题没给的悬停色、按下色、强调色的悬停与按下、`Inverse`（toast 和 tooltip 的反色）、`Scrollbar` 等，从已有 role 在 Oklch 空间按固定亮度和彩度偏移推导（`ui.Oklch`）。
- **`AccentText`**：根据强调色的亮度，在黑白或主题 `base` / `text` 中选对比度更高的一个。
- **对比度护栏（WCAG AA）**：
  - 门槛：正文对背景 ≥ 4.5:1；次要文字和占位符 ≥ 3:1；强调按钮上的文字 ≥ 4.5:1。
  - 用户自定义的强调色和覆盖色不达标时，只微调亮度、不改色相，预览里提示「已为可读性调整」。
  - 内置主题如果原样不达标，例如某些主题的 comment 色，只在作为正文的 role 上调整，调色板本身不动。
- **字体回退**：
  - 字体**不随安装包分发**，只用系统已安装的字体（已定）。
  - 启动时用 `ui.FontFamilies()` 确认用户选的字体存在。不存在时回退到系统字体：UI 字体回退到系统 UI 字体（`Theme.Font = ""`），buffer 字体回退到系统等宽字体（`"monospace"`）。默认的 Maple Mono NF CN 也走同样的规则。
  - 不弹窗打扰，只在外观设置页提示「未安装 xxx，当前使用系统字体」。
  - 设置页显示「当前实际使用：xxx」，并提示没有安装首选字体。
  - 字体列表首次加载较慢（文档说字体多时要数十毫秒），所以放在打开外观页时异步加载。
- **缓存**：结果按「prefs + 主题文件内容」的哈希缓存，切换时只算一次，不是每帧重算。

### 5.4 存储

在现有 `ui.json`（`desktop/prefs.go`）上扩展。原有的 `theme` 字段就是外观模式，保持兼容。新增带版本号的 `appearance` 对象。任何字段非法都退回默认值，主题 id 找不到时退回默认主题，沿用现有的校验思路。

```json
{
  "theme": "system",
  "language": "system",
  "appearance": {
    "version": 1,
    "lightScheme": "datawhisper-light",
    "darkScheme": "datawhisper-dark",
    "accent": "",
    "uiFont":     { "family": "Maple Mono NF CN", "size": 14, "weight": 400 },
    "bufferFont": { "family": "Maple Mono NF CN", "size": 13, "weight": 400, "lineHeight": 1.5, "ligatures": false },
    "bodyFont": "buffer",
    "bodyLineHeight": 1.7,
    "layout": "compact",
    "density": "standard",
    "radius": "standard",
    "chatWidth": "standard",
    "userBubble": true,
    "syntax": "auto",
    "chart": "auto",
    "chartPalette": "scheme",
    "reduceMotion": "system"
  }
}
```

`accent` 有三种写法：空串表示用主题默认；调色板名称（如 `"peach"`）表示随亮、暗主题各取各的同名色；`#hex` 表示固定颜色。

### 5.5 实现要点

- 新增 `desktop/internal/theme`：主题加载（内置 + 用户目录）、`Resolve`、对比度工具、字体回退。app 侧的缓存与每帧应用在 `internal/app/appearance.go`。
- 新增 `desktop/internal/theme/themes/*.json`：内置主题数据，附带 `THIRD_PARTY.md` 或在「关于」中列出出处。
- **颜色只经 token 取**：组件里禁止写死 `ui.Hex(...)`。加一条测试，用 `grep` 扫描保证这一点。
- **字体只经 token 取**：组件里不直接写字体名，统一走 `uiFont` / `bufferFont`。现有的 `monoFont()`（`sources.go:147`）改为读 buffer 字体。
- **图表 web view 同步**：主题变化时，向已打开的 web view 推 `theme.changed` 事件（MyGo 的 Go 与页面之间的绑定），页面更新 CSS 变量，并给 plotly / echarts 重新套模板。新打开的页面在加载参数里带上当前主题。
- **原生部分的边界**：菜单栏和窗口按钮只跟随亮 / 暗（`mygo.ThemeSource`），不吃自定义配色，预览里注明。可选做法是隐藏系统标题栏、自己画（`TitleBarStyle` + `ui.TitleBar`），让标题栏也跟随配色，放在 P5 评估。

### 5.6 测试

- **主题数据测试**：每个内置主题 JSON 都能解析；role 引用的调色板名称都存在；色值和上游规范一致（入库时附上核对来源）。
- **`theme.Resolve` 单测**：每个内置主题 × 若干强调色，断言对比度护栏成立、推导出的悬停色和按下色亮度单调；用户主题缺字段、引用不存在的颜色、色值非法时，都能退回默认。
- **prefs 单测**：坏文件、未知字段、越界字号、找不到的主题 id 都退回默认；旧版 `ui.json`（只有 `theme` 和 `language`）可以无损升级。
- **字体回退单测**：模拟首选字体不存在时的回退链。
- **视觉回归**：用 `ui.Tester` / `ui.Render` 把预览页按「内置主题 × 密度」渲染成截图，作为基线入库，人工抽查。

---

## 6. MyGo 落地映射

| 需要 | MyGo 现成 | 需自建（封装成本仓库组件） |
|---|---|---|
| 侧栏、分组、徽标 | `Sidebar` / `SidebarSection` / `SidebarItem` / `Badge` | 时间分组逻辑 |
| 可拖动分栏 | `Split` / `SplitPercent` | — |
| 菜单、右键、弹层 | `MenuButton`、`Element.ContextMenu`、`Popover`、`Modal`、`AlertDialog`、`Toast`、`Tooltip` | — |
| 回答渲染 | `markdown.Stream` / `markdown.View`（GFM 表格、代码高亮、可定制代码块头） | 代码块复制按钮、出处角标 |
| 表格 / 树 | `Table`、`Tree`、`List`（虚拟化） | — |
| 输入 | `TextArea`、`TokenField`、`SearchField`、`EditableText`、`ColorPicker` | 自动长高（需 spike） |
| 图标 / 字体 | `ui.Icon` + `MustParseSVG`、`ui.FontFamilies`、`FontWeight`、`FontFeatures` | 内嵌 Lucide 子集；字体回退到系统字体 |
| 主题 | `ui.Theme`、`markdown.Theme`（`Font` / `CodeFont` / 两种行高 / `CodeColors`）、`editor.Theme`、`ui.Oklch` | 主题 JSON 加载、`theme.Resolve`、对比度护栏 |
| 动效 / 阴影 | `ElementTransition`、`Shadow` | — |
| 命令面板 | — | `Modal` + `SearchField` + `List` + `OnShortcut` |
| 抽屉 | — | `DialogBase` / `Overlay` + `Transition` |
| 骨架屏 | — | `Box` + 循环动画（参考官方 `examples/chat-glow` 的 shimmer） |

参考：官方 `examples/markdown-chat`、`chat-glow`、`embed-webview`、`frameless`；showcase 中 Lorca、Kero 的布局。
社区目前没有第三方组件库。

已知限制：Linux 无 vibrancy；web view 是独立合成层（玻璃效果看不穿、`CapturePage` 中是空洞）、
Linux 上滚动事件先交给原生 UI；MyGo 仍是 v0.x，API 变动频繁。

---

## 7. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 视觉地基** | 内嵌图标；`internal/theme` + 主题 JSON 格式 + 默认主题（亮 / 暗）；显式设定 UI / buffer 字体（默认 Maple Mono NF CN，不随包分发）并实现回退到系统字体；字号层级、间距、主次按钮；图表跟随主题 | 亮 / 暗截图对比；系统 UI 字体改成其他字体后应用观感不变；`grep` 无硬编码颜色和字体名 |
| **P1 对话页** | 居中对话列；工作摘要折叠；回答操作栏；多行输入 + 附件 + 输入区模型选择；首页空状态；标题栏精简；ask 卡片重做 | 典型会话截图；键盘可完成提问、停止、选 ask 选项；i18n 无硬编码文案 |
| **P2 外观定制** | §5 全部：外观设置页与实时预览；首批开源主题（Catppuccin、Dracula 等）；强调色；UI / buffer 字体分别设定；界面风格 Compact / Islands；用户主题目录；对比度护栏；第三方声明 | §5.6 测试通过；内置主题截图基线 |
| **P3 检查器与出处** | 数据 / 产出物 / 运行三个标签；数字出处角标与弹层；图表卡片 + 全屏 | 任一数字可在 2 次点击内看到 SQL 与数据源 |
| **P4 接上后端** | 知识库、技能、jobs / workflow / teams、飞书、仪表盘管理；会话删除 / 搜索 / 置顶（需新增 RPC） | 每个后端能力都有入口与空状态 |
| **P5 打磨** | 命令面板、快捷键表、动效、错误 / 空状态文案、设置页重排 | 快捷键清单全部可用；命令面板覆盖所有菜单动作 |

**P0 进度（2026-11-04）**：已完成。内容：主题即 JSON（`desktop/internal/theme/themes/`）、`internal/theme`（解析、推导、对比度护栏、字体回退）、`ui.json` 的 `appearance` v1（`internal/prefs`）、Lucide 图标（`internal/icons`）、字号层级（`internal/app/style.go`）、侧栏 / 标题栏 / 用户气泡 / 工具卡片 / 输入区 / 图表卡片换上新样式、图表页面跟随主题（加载时注入，切换时 `Eval`）。
未在真实窗口里验证的：图表跟随主题（本地数据里没有带图表的会话，只有单元测试覆盖）。

**P1 进度（2026-11-05）**：已完成对话页的主体。
- 会话副本（`internal/conversation`）新增：思考行（`Role: "thinking"`，被遮蔽的块不显示）、每次回复的用量 / 时间 / 模型（挂在这次回复的最后一行）、排队输入的正文（`QueuedInputs`）。
- 对话页（`internal/app/chat_view.go`）：
  - 内容居中，宽 760；
  - 首页空状态：问候、提示、示例问题点一下填入输入框、打开数据面板；
  - 标题栏只留标题、重命名和数据面板开关，服务状态挪到侧栏底部；
  - Tern 式工具卡片：标题行、参数、输出只显示末尾 6 行并可展开或收起、底部状态与耗时；失败的调用完整展开；
  - 思考行默认折叠；
  - 每轮末尾一行元数据（时间、输入、输出、缓存、费用）加复制按钮；
  - 用户消息导航轨；
  - ask 卡片：单选点一下就回答，文案全部走 i18n；
  - 输入区：圆角卡片，多行输入随内容长高，Enter 发送、Shift+Enter 换行；底部是模型、思考强度、排队 / 引导和圆形的停止 / 发送按钮；上方是状态行（处理中与已用时）、排队标签和上下文用量条。
- 未做：消息的重新生成和编辑重发（需要服务端支持分支）、数字出处角标（P3）、整轮步骤折叠成摘要、轮次元数据的外观开关（P2）。

**P2 进度（2026-11-05）**：外观定制的主体已完成。
- 设置页新增「外观」分区（`internal/app/appearance_view.go`），左边选项、右边实时预览（用真正的消息组件画一段迷你对话），改动立即生效并写入 `ui.json`。
- 可调项：模式、亮 / 暗配色、强调色（配色默认 / 调色板色块 / 自定义取色器）、界面风格 Compact / Islands、密度、圆角、对话宽度、界面字体与 buffer 字体（字体可搜索、字号）、回答正文跟哪种字体、主题文件夹与重新加载、恢复默认。
- 内置开源配色 7 个家族 17 套（`internal/theme/themes/`），色值取自各上游官方来源，未改动；出处与许可证写在每个文件里，并列入「关于」对话框的第三方声明。
- Islands：窗口铺 `canvas` 底色，侧栏、对话区、数据面板各自成圆角岛。配色没有更深的中性色时（Nord、Solarized Dark），推导会自动把 `canvas` 压深一档。
- 未做：字重与连字（MyGo 的 `ui.Theme` 没有全局字重）、buffer / 正文行高的界面控件（`ui.json` 里已可设置）、代码高亮与图表配色的单独选择（目前跟随配色）、减少动效、主题导入 / 导出按钮（目前是主题文件夹加重新加载）、轮次元数据开关。

P2 依赖 P0 的 token 体系；P3 依赖 P1 的回合结构；P4 中会话管理的 RPC 可与 P1 并行由 server 侧先做。

---

## 8. 待定问题

1. **对话内图表**：静态缩略图（需要图表渲染出图）还是固定高度的交互 web view；先 spike Linux 上的滚动体验再定。
2. **自动长高输入框**：`TextArea` 是否支持按内容计算高度，P1 前 spike。
3. **工具步骤文案**：工具名 → 人话的映射放桌面 i18n，还是由 server 在工具元数据里给出（后者多端一致，倾向后者）。
4. **主题导入转换器**：是否要把 VS Code / Zed 主题转成本应用的 JSON（§5.2）。先只支持本格式，有需要再加。

## 9. 已定决策

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-11-04 | UI 字体与 buffer 字体默认都是 Maple Mono NF CN | 用户偏好；本机已安装 |
| 2026-11-04 | 字体**不随安装包分发**；没装时回退到系统字体（UI → 系统 UI 字体，buffer → 系统等宽字体） | Maple Mono NF CN 单个字重约 20MB，打包代价过大 |
| 2026-11-04 | 回答正文默认跟 buffer 字体 | 回答属于内容，与代码、表格保持一致 |
| 2026-11-04 | Dracula 提供暗色 Dracula 与亮色 Alucard 两个变体 | 两者都在 Dracula 官方免费规范内 |
| 2026-11-04 | 外观模式为亮 / 暗 / 跟随系统；配色支持 Catppuccin、Dracula 等开源主题，主题即 JSON | 用户需求 |
| 2026-11-05 | 外观新增「界面风格」：Compact（默认）/ Islands | 用户需求；现在的排版即 Compact |
| 2026-11-05 | 窗口内菜单栏自动隐藏（`AutoHideMenuBar`），Alt / F10 唤出，快捷键照常 | 用户不要窗口顶部那一行菜单 |
