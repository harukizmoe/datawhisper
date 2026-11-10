/**
 * 内置工作流模板：`workflow_create` 按模板与审批模式生成一张图。
 *
 * 旧实现（`agent/tools/workflow.py::_create_template_graph`）里每个节点引用一份「agent profile」
 * （角色名、系统提示、工具白名单）存在单独的存储里。新实现没有 profile：角色提示与工具白名单直接写在
 * 节点上（`prompt` / `allowed_tools`），图是自包含的，保存一份文件即可复现整个流程。
 *
 * 节点提示是给模型看的，一律用英文，并要求按「业务背景」所用的语言作答：这样中英文界面都能用同一份模板。
 */

import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types.ts";

export type WorkflowMode = "full_auto" | "key_approval" | "exception_review";
export type WorkflowTemplate = "analysis" | "insight" | "report" | "cleaning_approval";

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = ["analysis", "insight", "report", "cleaning_approval"];
export const WORKFLOW_MODES: readonly WorkflowMode[] = ["full_auto", "key_approval", "exception_review"];

/** 只读的数据查询工具；分析类节点只需要它们。 */
const READ_TOOLS = ["get_schema", "query_data"];

const LANGUAGE_RULE =
  "Write your answer in the language of the business context (if none is given, use the language of the data's column names and values).";

/** 把模板用到的节点补上共同的限制（旧实现每个节点都带 `limits`）。 */
function agentNode(node: WorkflowNode): WorkflowNode {
  return { type: "agent", max_attempts: 2, ...node };
}

function edge(id: string, from: string, to: string, type: WorkflowEdge["type"] = "auto", maxIterations?: number): WorkflowEdge {
  return { edge_id: id, from_node: from, to_node: to, type, ...(maxIterations === undefined ? {} : { max_iterations: maxIterations }) };
}

const INSPECT: WorkflowNode = agentNode({
  node_id: "inspect_data",
  prompt:
    "Inspect the data sources available in this conversation: tables, columns, row counts, missing values, duplicates, obvious outliers and which metrics can be computed. " +
    `Output a non-empty data quality report with the sections Data Overview, Quality Issues and Usable Metrics. ${LANGUAGE_RULE}`,
  input_contract: ["business_context"],
  output_contract: ["data_quality_report"],
  allowed_tools: READ_TOOLS,
  side_effects: ["read_data"],
});

const METRICS: WorkflowNode = agentNode({
  node_id: "analyze_metrics",
  prompt:
    "Using the data quality report and SQL queries on the data, compute the key business metrics for the stated goal: totals, trends, breakdowns by the main dimensions, and period-over-period change. " +
    `Cite the numbers you computed. Output a metric analysis. ${LANGUAGE_RULE}`,
  input_contract: ["data_quality_report", "business_context"],
  output_contract: ["metric_analysis"],
  allowed_tools: READ_TOOLS,
  side_effects: ["read_data"],
});

const ANOMALIES: WorkflowNode = agentNode({
  node_id: "analyze_anomalies",
  prompt:
    "Using the data quality report and SQL queries on the data, find fluctuations and anomalies and explain their likely causes with evidence from the data. " +
    `Output an anomaly analysis. ${LANGUAGE_RULE}`,
  input_contract: ["data_quality_report", "business_context"],
  output_contract: ["anomaly_analysis"],
  allowed_tools: READ_TOOLS,
  side_effects: ["read_data"],
});

const REVIEW: WorkflowNode = agentNode({
  node_id: "verify_findings",
  join_policy: "all_success",
  prompt:
    "Cross-check the metric analysis against the anomaly analysis using only those two inputs. Output a non-empty verification report: first a one-line conclusion (consistent, partly inconsistent, or inconsistent), " +
    `then the specific contradictions or unsupported claims, if any. ${LANGUAGE_RULE}`,
  input_contract: ["metric_analysis", "anomaly_analysis"],
  output_contract: ["verification_report"],
  allowed_tools: [],
});

function reporter(inputs: string[]): WorkflowNode {
  return agentNode({
    node_id: "generate_report",
    prompt:
      "Write a complete business analysis report for management from the inputs: executive summary, key metrics and performance, structure and drivers, risks and anomalies, and recommended actions. " +
      `Use only facts present in the inputs. ${LANGUAGE_RULE}`,
    input_contract: inputs,
    output_contract: ["operating_report"],
    allowed_tools: [],
    output_validation: { forbidden_substrings: ["empty / not provided", "no upstream findings", "no verification report content"] },
  });
}

/** 数据清洗模板：方案 → 独立复核（可打回）→ 人工审批 → 执行 → 报告。 */
function cleaningGraph(mode: WorkflowMode): WorkflowGraph {
  return {
    run_policy: { mode: mode === "full_auto" ? "key_approval" : mode },
    entry_node_ids: ["validate_input"],
    nodes: [
      {
        node_id: "validate_input",
        type: "validation",
        input_contract: ["business_context"],
        output_contract: ["validated_input"],
        validation: { required: ["business_context"], non_empty: ["business_context"] },
      },
      agentNode({
        node_id: "propose_cleaning",
        prompt:
          "Propose an auditable data cleaning plan and do NOT modify any data. Name exactly one existing source table, list only operations of type fill_na, winsorize or trimming with explicit fields and parameters, " +
          `the expected impact, and a rollback path. If a revision request is present, address it. ${LANGUAGE_RULE}`,
        input_contract: ["validated_input", "business_context", "revision_request"],
        output_contract: ["cleaning_plan"],
        allowed_tools: READ_TOOLS,
        side_effects: ["read_data"],
        max_iterations: 3,
      }),
      agentNode({
        node_id: "verify_cleaning",
        type: "verifier",
        prompt:
          "Independently review the cleaning plan; do not change it. Check: it names exactly one existing source table and never overwrites it; every operation is fill_na, winsorize or trimming with explicit fields and parameters; it states the expected impact and a rollback path. " +
          'Return only a JSON object {"decision": "pass" | "rework" | "escalate", "issues": [...], "evidence": [...]}.',
        input_contract: ["cleaning_plan"],
        output_contract: ["decision", "issues", "evidence"],
        allowed_tools: READ_TOOLS,
      }),
      agentNode({
        node_id: "apply_cleaning",
        prompt:
          "Execute the approved cleaning plan exactly. Call clean_data exactly once with only the operations in the plan, then report what was done. " +
          LANGUAGE_RULE,
        input_contract: ["cleaning_plan"],
        output_contract: ["cleaning_execution"],
        allowed_tools: ["clean_data", "get_schema", "query_data"],
        side_effects: ["write_data"],
        // 写数据的节点崩溃后不能被重放第二次。
        replay: "unsafe",
        max_attempts: 1,
      }),
      reporter(["cleaning_plan", "cleaning_execution"]),
    ],
    edges: [
      edge("validate-to-plan", "validate_input", "propose_cleaning"),
      edge("plan-to-verify", "propose_cleaning", "verify_cleaning"),
      // 执行节点要拿到方案本身，所以方案也直连它；它仍要等复核节点通过审批才会就绪（所有前驱都成功）。
      edge("plan-to-clean", "propose_cleaning", "apply_cleaning"),
      edge("verify-to-clean-approval", "verify_cleaning", "apply_cleaning", "approval"),
      edge("plan-to-report", "propose_cleaning", "generate_report"),
      edge("clean-to-report", "apply_cleaning", "generate_report"),
      edge("verify-rework", "verify_cleaning", "propose_cleaning", "retry_loop", 3),
    ],
    limits: { max_run_minutes: 60 },
  };
}

/** 按模板与审批模式生成图。`key_approval` 时，模板里的关键边（出报告、写数据）换成审批边。 */
export function buildTemplateGraph(template: WorkflowTemplate, mode: WorkflowMode): WorkflowGraph {
  const gate: WorkflowEdge["type"] = mode === "key_approval" ? "approval" : "auto";
  switch (template) {
    case "insight":
      return {
        run_policy: { mode },
        entry_node_ids: ["inspect_data"],
        nodes: [INSPECT, METRICS],
        edges: [edge("inspect-to-metrics", "inspect_data", "analyze_metrics")],
        limits: { max_run_minutes: 30 },
      };
    case "report":
      return {
        run_policy: { mode },
        entry_node_ids: ["inspect_data"],
        nodes: [INSPECT, reporter(["data_quality_report", "business_context"])],
        edges: [edge("inspect-to-report", "inspect_data", "generate_report", gate)],
        limits: { max_run_minutes: 45 },
      };
    case "cleaning_approval":
      return cleaningGraph(mode);
    case "analysis":
      return {
        run_policy: { mode },
        entry_node_ids: ["inspect_data"],
        nodes: [INSPECT, METRICS, ANOMALIES, REVIEW, reporter(["metric_analysis", "anomaly_analysis", "verification_report"])],
        edges: [
          edge("inspect-to-metrics", "inspect_data", "analyze_metrics"),
          edge("inspect-to-anomalies", "inspect_data", "analyze_anomalies"),
          edge("metrics-to-verify", "analyze_metrics", "verify_findings"),
          edge("anomalies-to-verify", "analyze_anomalies", "verify_findings"),
          edge("verify-to-report", "verify_findings", "generate_report", gate),
          edge("metrics-to-report", "analyze_metrics", "generate_report"),
          edge("anomalies-to-report", "analyze_anomalies", "generate_report"),
        ],
        limits: { max_run_minutes: 120 },
      };
  }
}

/** 旧实现接受的别名；无法识别时返回 undefined，由调用方报错。 */
const TEMPLATE_ALIASES: Readonly<Record<string, WorkflowTemplate>> = {
  analysis: "analysis",
  经营: "analysis",
  分析: "analysis",
  insight: "insight",
  洞察: "insight",
  查询: "insight",
  report: "report",
  报告: "report",
  cleaning_approval: "cleaning_approval",
  清洗: "cleaning_approval",
  数据治理: "cleaning_approval",
};

export function normalizeTemplate(value: unknown): WorkflowTemplate | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "analysis";
  if (text === "") return "analysis";
  const exact = TEMPLATE_ALIASES[text];
  if (exact !== undefined) return exact;
  for (const [alias, template] of Object.entries(TEMPLATE_ALIASES)) if (text.includes(alias)) return template;
  return undefined;
}

const MODE_ALIASES: Readonly<Record<string, WorkflowMode>> = {
  full_auto: "full_auto",
  auto: "full_auto",
  自动: "full_auto",
  全自动: "full_auto",
  key_approval: "key_approval",
  approval: "key_approval",
  审批: "key_approval",
  关键审批: "key_approval",
  exception_review: "exception_review",
  exception: "exception_review",
  异常: "exception_review",
  异常复核: "exception_review",
};

export function normalizeMode(value: unknown): WorkflowMode | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "full_auto";
  return text === "" ? "full_auto" : MODE_ALIASES[text];
}
