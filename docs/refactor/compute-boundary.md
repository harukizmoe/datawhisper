# compute 边界：哪些逻辑留在 Python，为什么

本文说明重构后 compute 进程的职责范围、它与 server 的协议、`data/` 整包的去留，以及还没补齐的缺口。
判断依据是代码里实际的调用关系，不是计划里的意图。

## 一句话结论

- **Python 只保留「算」**：数据源实现（DuckDB / pandas / 各种连接器）、SQL、统计分析、机器学习、图表模板与导出。
- **其余全部在 Bun**：模型回合、工具编排、权限、工作区、知识库索引与检索、飞书、MCP、持久化。Python 不碰网络、不碰凭据、不碰会话状态。
- `data/` **继续作为 Python 包保留**，它被 compute 直接 import（数据源实现、工作区持久化、导入限流），没有第二份实现，也没有迁移收益。
- 三个注册表里声明了但**没有执行器**的工具（`fetch_table`、`browser_extract_tables`、`load_feishu_bitable`）目前是死声明；处理方式见「已知缺口」。

## 进程边界

```
desktop (Go/MyGo) ──stdio JSON-RPC 2.0──▶ server (Bun)
server ──stdio JSON-RPC 2.0──▶ compute (Python)
```

- 没有端口、没有令牌、没有 HTTP 服务。
- server 是唯一的状态持有者：会话文档、来源记录、工作区注册表、权限模式。compute 每次调用只拿到本次需要的上下文（`context.sources` 等）。
- compute **无状态**：进程重启后不保留任何「上一次分析」的记忆；需要保留的东西由 server 写成产物或表，再由下一次调用读回。

## compute 的 RPC 面（50 个方法）

| 分组 | 数量 | 内容 |
|---|---|---|
| `source.*` | 11 | 打开/关闭/预览/结构/分析表选择；CSV、Excel、PDF、远程 SQL、工作区持久库 |
| `tool.*` | 16 | A/B 类分析工具的执行端：`query_data`、`get_schema`、`profile_data`、`run_analysis`、`generate_chart`、`clean_data`、`export_*`、`generate_ppt/dashboard` 等 |
| `knowledge.*` | 12 | 知识库的写入、切片、检索、文件管理 |
| `embed.*` | 5 | 向量化（本地 onnxruntime / tokenizers） |
| `dashboard.*` | 2 | 仪表盘刷新与导出 |
| `chart.*` | 1 | 图表模板渲染 |
| 其它 | 3 | `ping`、`upload.prepare`、`workspace.sync` |

模型调用、工具暴露、结果整形、权限检查都不在这 50 个里——它们属于 server。

## 为什么这些留在 Python

| 能力 | 现状依赖 | 迁到 TypeScript 的代价 |
|---|---|---|
| 数据源 | DuckDB、pandas、SQLAlchemy 方言（MySQL / SQL Server / PostgreSQL）、openpyxl、pdfplumber | 重写全部连接器与类型推断，收益为零 |
| SQL 与统计 | DuckDB 引擎 + 统计检验（scipy/statsmodels/pmdarima） | 没有等价物；pmdarima 的 ARIMA 结果要和录制回放对齐 |
| 机器学习 | scikit-learn、Prophet、PyTorch（`Function/Analyze/*`） | 模型权重与训练流程都在 Python 生态里 |
| 图表与导出 | plotly / matplotlib 模板、python-pptx、openpyxl 导出 | 模板与像素级输出都在 Python 侧，且有 golden |
| 知识库与向量化 | jieba 分词、onnxruntime、tokenizers | 中文分词与本地嵌入模型只有 Python 绑定 |

留在 Python 的判据是「需要 Python 生态的数值/文件能力」，不是「以前在 Python 里」。纯逻辑（校验、编排、文案、协议）一律在 server，避免同一规则两处实现。

## `data/` 整包的去留

结论：**保留**，不作为迁移对象。

理由（按证据）：

1. `compute/` 直接 import `data.workspace`、`data.sources.*`、`data.table_extract`、`data.shape_libs` 之外的实现；`data/` 不是旧 agent 的残留外壳。
2. `data/sources/workspace_persistent.py` 同时用到 `data/workspace.py`（工作区运行时）与 `data/large_import_limiter.py`（导入限流），两者都在这条路径上，删掉任何一侧都要重写工作区持久化。
3. 反向看：`data/` 里**没有**任何 server 侧已有实现的重复品（模型调用、工具编排、权限都不在里面）。
4. 迁移到 `compute/` 只是目录搬家，会让 compute 与「compute 的测试」的 import 路径全部变化，收益是目录整齐，风险是几百处相对 import 与打包路径。

因此「评估 data/ 整包」的结论是保持现状；真正的清理只做**混在代码目录里的数据文件**与**已无引用的依赖**，见下。

## 本轮清理

| 项 | 处理 | 依据 |
|---|---|---|
| `openai` Python 依赖 | 删除 | 全仓 Python 代码无 `import openai`；模型调用早已在 Bun 侧 |
| `data/shape_libs`（168 KB 的 draw.io 形状库） | 移到 `server/assets/shape_libs` | 它是数据文件而不是代码；唯一引用在 server 的画图工具（`AppToolDeps.shapeLibsDir`） |
| `infrastructure/*` | **保留** | `paths`、`artifact_lifecycle` 被 compute 与 `data/` 直接使用；`gpu_detect` 被 `training_device` 使用；`cpu_pool`、`training_router` 被 `Function/Analyze/*` 使用 |
| `chart.png` | 不存在，无需处理 | 图表以模板与内联数据生成 |

## 网表/飞书表的入口（原「没有执行器」的三个工具）

`fetch_table`、`load_feishu_bitable` 已经可用；`browser_extract_tables` 按既定范围（不做浏览器交互）只保留声明，
调用时明确回答「这一版没有浏览器自动化，请改用 fetch_table 或上传文件」。

链路：

1. **工具层**（`server/src/tools/app/ingest.ts`）负责取字节：`fetch_table` 做 SSRF 校验（URL 协议、私网字面量、
   DNS 解析、重定向后的最终地址）、30 秒超时、12 MiB 上限；`load_feishu_bitable` 通过飞书机器人读记录
   （`readBitableRecords`，凭据不经过工具）。
2. **登记端口**（`IngestPort`，由 `sourceMethods` 装配时填入）：带上本会话的 compute 上下文，让 compute 跑
   `tool.fetch_table_parse` / `tool.load_feishu_bitable`，并把解析出的每张表写成 CSV 到
   `<数据目录>/uploads/incoming/<scratch>/`。
3. compute 侧临时注册的内存来源在落盘后立刻关掉；CSV 再按普通 `csv` 来源逐张登记进会话文档，所以
   **重启后仍然打得开**（此前只能活在内存里）。
4. 结果正文 = compute 的解析摘要（表名、行数、列名、截断标记）+ 已登记的来源清单。

## 参数校验：现状与目标

现状：每个 `server/src/ipc/*` 方法自己校验参数（`stringParam`、`patternParam`、`conversationIdParam` 等），错误统一带 `kind` / `reason`，桌面端按 `kind` 决定提示。**compute 侧同样有一层校验**（Python 的 `INVALID_PARAMS`），因为 compute 也要能被单独启动调试。

目标（handoff step 1）：把 server 每个 RPC 的入参整理成一份声明，在方法入口统一校验一次，把手写校验收敛成「形状 + 语义」两层。收益是错误信息一致、桌面端不需要逐个方法猜参数名；风险是方法多（50+），两套规则并存期间容易漂移。

进展：`server/src/ipc/params.ts` 提供 `checkParams(params, rules)` 与 `WORKSPACE_ID_RULE`，只做形状校验（类型、必填、`pattern`、`minLength`、数组项数与元素形状），语义仍留在方法里；错误文案可以按旧实现逐字覆盖，避免界面提示漂移。已采用：`workspace.tree` / `workspace.pending` / `workspace.readFile`（`test/params.test.ts`、`test/workspace-tree.test.ts`）。未采用：`workspace.create/update/sync/importFiles/prepare/remove` 与整个 `source.*` 组仍是手写校验，按「最近改得最多的组先动」的顺序排在后面。

## 验证方式

- 边界内的纯计算：`compute/tests`（`test_ui_methods`、`test_rpc`、`test_tools`）。
- 边界协议：`server/test/sources-ipc.test.ts`、`server/test/workspace-tree.test.ts`（用真实 stdio 的假 compute 或录制回放）。
- 打包后的进程边界：`build-release.yml` 里起一次 server 并等 `ready`、起一次 compute 并发 `ping`。
