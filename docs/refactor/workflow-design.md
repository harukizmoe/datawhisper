# 工作流：让它能用起来（方案 B）

状态：待确认。基线：引擎已有（`server/src/workflows/`），入口、保存、节点类型、审批都没有。

## 目标

用户在聊天里说"帮我建一个每周销售复盘的工作流"，模型能创建、保存、启动它；运行在后台跑完；有副作用的步骤停下等用户在界面上批准；失败的节点能从失败处重来。

## 现状（已核实）

| 部分 | 现状 |
|---|---|
| 调度引擎 | 有：依赖、条件边、重试、配额、预算、崩溃恢复、取消 |
| 节点执行器 | 只认 `agent` 节点；节点会话是新建的独立会话，**没有数据源、没有工具收敛**（`service.ts` 没传 `prepareConversation`） |
| 启动 | `workflows.start` 没有调用方 |
| 模型工具 | `workflow_create/_custom/list/start/status` 只在 `registry.ts` 有声明，没有实现 |
| 保存 | 旧版按工作区存"已发布 Workflow"，没迁 |
| 审批 / verifier 打回 / 手动重试 | 没有；带 `approval` 边的图被 `workflow_approval_not_supported` 拒绝 |
| 界面 | Runs 页只读：列表、详情、取消 |

## 设计

### 1. 保存
应用数据目录下 `workflows/<id>.json`（`{id, name, description, graph, createdAt}`），全局可见（单用户，不再按工作区分）。不做版本历史：改图就是新建一份。

### 2. 模型工具（5 个）
- `workflow_create`：按模板建（`analysis`、`insight`、`report`、`cleaning_approval`），参数 `name`、`mode`（`full_auto` / `key_approval` / `exception_review`）。
- `workflow_create_custom`：模型自己给出完整图，服务端用现有 `validateWorkflowGraph` 校验后保存。
- `workflow_list`、`workflow_start`（参数：工作流 id、业务背景文字）、`workflow_status`（运行 id）。

模板里每个节点自带角色提示词（`prompt`）和工具白名单，不再要旧版的"agent profile"存储。

### 3. 节点能力
- `agent`：已有。
- `verifier`：agent 节点，约定输出 JSON `{decision: pass|rework|escalate, issues, evidence}`。`rework` 触发 `retry_loop`，`escalate` 视为需要人工。
- `validation`：确定性检查（`required`、`non_empty`），不调模型。
- `sql` / `export` / `router` 不做：模板用不到。

### 4. 节点会话需要数据
节点会话要能用数据源，否则分析节点什么也查不了。做法：启动运行时记下发起会话，节点会话创建后复用那个会话已打开的数据源（只读），并按节点的工具白名单收敛可用工具。**这是最大的风险点**，实现前先确认数据源上下文按会话 id 绑定的接缝能不能直接复用。

### 5. 审批（`key_approval` / `exception_review`）
- 运行索引文档里加一份审批记录：`{id, nodeId, nodeRunId, reason, status, comment}`。
- `key_approval`：有 `approval` 出边的节点，成功后不直接算成功，进入 `waiting_approval`，下游等着。
- `exception_review`：节点用完重试仍失败时进入 `waiting_approval`，由人决定重来或终止。
- 决定三种：`approve`、`reject_and_retry`（附意见，打回重做，不超过 `max_iterations`）、`reject_and_stop`。`approve_with_changes`（人改输出）这一轮不做。
- 运行等待人时：调度 phase 在没有活节点、有待批审批时进入"等待"。用一个"门任务"当唤醒句柄，决定写入索引后由门任务落定，运行重新调度；决定与唤醒在同一次提交里，崩溃不会卡死。
- 运行状态 `waiting_approval`，节点状态新增 `waiting_approval`。

### 6. verifier 打回
verifier 节点输出 `decision=rework` 时：自己记成功，沿 `retry_loop` 把目标节点（含它自己）开新一轮 iteration；超过 `max_iterations` 则节点失败，**不会**带着已知有问题的方案进入审批。

### 7. 手动重试
终态任务不能重新打开，所以"重试"= 以失败的运行为种子另起一次运行：失败节点及其下游重新跑，其余成功节点沿用上次输出。新运行记 `retryOf`。

### 8. 界面（数据面板 Runs 页）
- 运行行显示状态；`waiting_approval` 的运行置顶并标出。
- 运行详情里待批节点显示意见框与三个按钮：Approve、Rework、Stop。
- 失败的运行显示 Retry from failed node。
- 工作流定义只读列表放在 Runs 页顶部（名称、模式、节点数），不做编辑界面（创建走聊天）。

## IPC 增量
`workflow.list`、`workflow.get`、`workflow.start`、`workflow.runs.approve`（`{runId, approvalId, decision, comment}`）、`workflow.runs.retry`（`{runId, nodeRunId}`）。

## 里程碑
1. 保存 + 5 个工具 + `workflow.start`/`list`（无审批的全自动流程能跑通）。
2. 节点会话的数据源与工具收敛。
3. `verifier`、`validation` 节点 + verifier 打回。
4. 审批 + 门任务。
5. 手动重试。
6. Runs 页界面。
7. 用 magpie 网关和 docker postgres 端到端跑一遍 `analysis` 与 `cleaning_approval`。

## 待定
见确认表单。
