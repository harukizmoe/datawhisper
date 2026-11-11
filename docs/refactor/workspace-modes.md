# 对话模式：普通聊天与工作区

状态：设计稿，待确认后实施。分支 `refactor/pi-durable`。

## 目标

仿 ChatGPT：新建对话时可以是**普通聊天**，也可以**指定一个工作区**（对应 ChatGPT 的 Project）。工作区是一个有名字的本地文件夹，里面的对话共享它的文件、数据、说明和产物目录。

## 现状（读代码所得）

- 工作区只是会话里的一个附件：`SourceDoc.workspaces[]`，一个会话同时只挂一个，入口是数据面板「工作区」页签。
- 挂载 = `workspace.sync` 把目录里的 csv/xlsx 导进 `<目录>/.zhixi/workspace.duckdb`，登记成 `workspace_persistent` 来源。同一目录在每个会话里各挂一次、各同步一次。
- `TurnState.hasWorkspace` 决定 9 个 `workspace_*` 文件工具和工作区提示规则是否暴露。
- server 给 compute 的上下文没有 `workspace_id` / `workspace_root`，所以导出落点和 SQL 读取白名单都不跟随工作区（Python 侧已能接收，见 `2180b27`）。
- `conversation.create` 没有范围参数；用户看不出当前对话在什么范围里。

问题：工作区是「会话的附件」，不是「一种会话」。

## 模型

对话的**范围（scope）**在创建时确定：`chat`，或 `workspace:<id>`。

范围不是两套工具。普通聊天同样能上传文件、连数据库做分析；工作区在它之上**多出**下面几项。

| 能力 | 普通聊天 | 工作区内的对话 |
|---|---|---|
| 数据来源 | 上传、连接（仅本对话可见） | 同左，另加工作区共享来源（本工作区所有对话可见） |
| `workspace_*` 文件工具 | 不暴露 | 暴露；写类工具要求权限为 `read_write` |
| SQL `read_csv` 白名单 | uploads、Information | 另加工作区目录及其 `artifacts`、`.baa_cache`、`.zhixi` |
| 导出文件落点 | `<dataDir>/outputs/exports` | `<目录>/artifacts/` |
| 附加说明 | 无 | 工作区说明（instructions）并入系统提示 |
| 知识库 | 用户级 | 用户级，另加 `<目录>/.zhixi/knowledge`（Python 侧已支持） |

两种范围都支持连接 SQL（数据库、Google Sheets、飞书、HTTP 来源）。差别只是工作区多出上表那几项，不是能力开关。

## 数据结构

工作区注册表 `<dataDir>/workspaces.json`（原子写，风格同数据源配置存储）：

```
{ id, name, path, permission: "read_only" | "read_write",
  instructions,            // ≤ 8000 字，存在应用目录，不写进用户文件夹
  sourceId,                // 目录同步出的持久化来源，全工作区共用一个
  sharedConfigIds[],       // 工作区共享的远程来源配置
  lastSyncedAt, createdAt }
```

会话：`SourceDoc` 增加 `scope: { kind: "chat" } | { kind: "workspace", workspaceId }`。旧的 `workspaces[]` 迁移后移除。

有效来源 = 会话私有来源 + 工作区共享来源。启用开关（`active`）仍按会话。

## IPC

- 新增全局的 `workspace.create / update / remove / list / sync`；`rename`、`setPermission` 并入 `update`。
- `conversation.create({ workspaceId? })`；`conversation.list` 与会话摘要带上 `scope`。
- `conversation.moveToWorkspace({ id, workspaceId })`：普通聊天单向移入工作区。
- 现有按会话的 `workspace.mount / unmount` 被取代，不留兼容别名（仓库约定：干净切换）。

## 服务端行为

- `hasWorkspace` = scope 为 workspace 且注册表有记录且目录仍存在。工具收敛逻辑（`toolsForTurn`）不改。
- `assemble.ts` 给 compute 的上下文补发 `workspace_id`、`workspace_root`。
- 回合开始时把工作区名称、路径、权限、说明作为一段 turn 文档并入系统提示。
- 目录被删或不可读：本轮明确报错，不静默退回普通聊天。
- 同步时机：创建工作区时、用户点「刷新」时；不在每轮同步。变更检测沿用 `registry.json` 的 sha256。
- 迁移：首次启动把各会话里 `mounted` 的工作区按路径去重，提升为全局记录，会话 scope 指向它；未挂载的历史记录变成无会话绑定的注册表项。

## 桌面端

### 新建对话时选范围

- 新对话的空白页上方是范围选择：`Chat` / `Workspace`。选 `Workspace` 后出现工作区下拉（已有的工作区加「Add folder…」）。默认沿用上次的选择。
- 范围在发出第一条消息时随 `conversation.create` 定下来，之后以标签显示，只能「移入」，不能脱离。
- 两种范围都能连接 SQL：数据面板的「Sources」页签在两种范围里一样，连接、测试、选分析表的流程不变。差别只在可见性：普通聊天里的连接只属于本对话；工作区里可以选择「仅本对话」或「共享给工作区」（S4）。

### 侧栏与标签

- 侧栏顶部：「New chat」「New workspace」。会话按组显示：每个工作区一组（组头有「新建对话」），其余归「Chats」。
- 输入区上方的范围标签：`Chat` 或 `📁 sales-2026 · read-only`。点开菜单：普通聊天可「Move to workspace…」；工作区对话显示工作区信息与「Open settings」。
- 「New workspace」对话框：文件夹选择、名称、权限（Select）、说明（多行）。
- 工作区设置页（S4）：名称、权限、说明、共享来源、刷新、移除。移除只删注册和缓存的 `.zhixi`，不动用户文件，需二次确认。
- 界面文案英文，中文只放 `i18n.go`。

### 工作区文件树（参照 Tern 的文件面板）

数据面板里，工作区对话的「Workspace」页签换成目录树；普通聊天里没有这个页签。

布局，自上而下：

- 头部：文件夹图标、工作区名、权限徽标（`read-only`）、折叠按钮。
- 页签图标：Files（树）、Changes（`±`，列出尚未导入或自上次导入后变化的数据文件，一键导入）。Tern 的第三个页签（git 分支）不做。
- 树：每行 = 展开箭头、类型图标、名称、右侧徽标。目录在前文件在后，各自按名称不区分大小写排序。
- 单子目录链折叠成一行，如 `docs / refactor`、`outputs / charts`。
- 隐藏目录和已知的大目录（`.git`、`.venv`、`node_modules`、`__pycache__`、`artifacts`、`.zhixi`、`.baa_cache`）灰显，默认折叠。命中敏感黑名单的文件（`.env`、`.ssh`、密钥证书）不显示。
- 空目录右侧标 `Empty`。
- 底栏：同步状态，如 `Synced 3 min ago · 12 tables · 2 new`。

徽标含义（对应 Tern 的 `?` 与圆点）：

| 位置 | 徽标 | 含义 |
|---|---|---|
| 文件行 | `?` | 数据文件（csv、xlsx 等）尚未导入 |
| 文件行 | 表格小图标 | 已导入，可直接 SQL 查询 |
| 文件行 | `!` | 导入后文件已变化 |
| 目录行 | 圆点 | 目录内有未导入或已变化的数据文件 |

交互：

- 点目录：展开或折叠，首次展开才向 server 取这一层。
- 点数据文件：预览前若干行（已导入的走 `source.previewTable`）；点文本文件：预览文本。
- 右键菜单（窗口内弹出菜单）：「Import」「Reference in chat」（把相对路径插入输入框）。面板不提供删除、重命名等写操作，改用户文件只由 agent 的 `workspace_*` 工具完成，并受 `read_write` 约束。

实现要点：

- 新增 `workspace.tree({ workspaceId, path })`，一次只返回一层：`{ name, kind, size, mtime, ignored, empty?, collapsedPath?, importState }`，每层最多 500 项，超出返回 `truncated` 与总数。单链折叠由 server 沿着「只有一个子目录」往下走并返回合并后的路径，客户端不必逐层请求。
- 路径校验复用 `tools/app/workspace/fs.ts` 的越界、符号链接、黑名单检查，不让客户端传绝对路径。
- 新增 `workspace.importFiles({ workspaceId, paths[] })`：导入指定文件（现有 `workspace.sync` 是整目录同步，改成这个的特例）。
- 导入状态来自 `registry.json` 的 sha256 与当前文件对比，不在列目录时算哈希（大文件会卡）：先比 size 与 mtime，不一致才标 `!`，确认哈希放到导入时。
- 图标用 Lucide 子集（`desktop/internal/icons`）：文件夹、文件、文本、表格、数据库、图片、代码；按扩展名选，不按目录名做特殊图标。
- 一律用 MyGo 官方组件；行数很多时用虚拟列表组件。

## 取舍

- 范围创建时定，中途只能「移入」，不能「脱离」：避免工具集在对话中途变少，历史里的 `workspace_*` 调用失去上下文。
- 一个对话只属于一个工作区（沿用现有「一次一个」）。
- 目录同步是显式动作，不做文件监听：监听在大目录和网络盘上不可靠，且用户看不出何时在读文件。
- 说明文本存应用目录而不写进用户文件夹：不污染用户的项目，也避免与用户自己的 `AGENTS.md` 冲突。

## 分期

| 期 | 内容 | 验收 |
|---|---|---|
| S1 server | 注册表、`workspace.*` 全局化、`conversation.create/moveToWorkspace`、scope、迁移、上下文补发、说明并入提示 | `bun test` 覆盖：创建、移入、迁移去重、目录消失报错、compute 上下文含根目录；工作区对话导出落 `artifacts/`；两种范围都能 `source.open` SQL |
| S2 desktop | 新建对话的范围选择、侧栏分组、范围标签、New workspace 对话框 | `ui.NewTester` 覆盖：空对话选范围、创建后会话带 scope、分组渲染；实机截图 |
| S3 文件树 | `workspace.tree`、`workspace.importFiles`、桌面端文件树面板与「Changes」页签 | 懒加载展开、折叠单链目录、导入状态徽标与实机一致；大目录不卡界面 |
| S4 | 共享来源、设置页、刷新 | 两个对话共享同一工作区来源；刷新只重导变化的文件 |
| S5 | 飞书机器人可选默认工作区；工作流可选工作区 | 另行评估 |

## 已采用的默认选择

下面四项我给过建议，未收到异议，按建议执行；要改请说：

1. 范围不能脱离，只能从普通聊天移入工作区。
2. `read_only` 下导出可以写 `artifacts/`；`read_only` 只禁 `workspace_write/edit/delete/move/bash`。
3. 共享来源放 S4，不阻塞 S1 至 S3。
4. 侧栏按工作区分组，不做筛选。
