/**
 * Single source of truth for built-in tool runtime policy (port of `agent/tools/registry.py`).
 *
 * JSON schemas stay with the tool implementations because they are prompt-facing and comparatively
 * large. Everything that controls *when and how* a tool runs lives here: exposure, data/workspace
 * requirements, concurrency, job thresholds, side-effect scope, and the confirmation policy.
 *
 * The table is hand-written on purpose (readable diffs, keyword sets reviewable in place);
 * `server/test/registry.test.ts` proves it field by field against `server/test/golden/registry.json`,
 * which is dumped from the Python registry by `scripts/golden/export_registry.py`.
 */

import { pyCompare, pyRepr } from "../agent/py-compat.ts";

export const TOOL_CATEGORIES = ["read", "analysis", "write", "output", "interaction"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const EXECUTION_MODES = ["sync", "auto", "job"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export type SideEffectScope = "none" | "session" | "workspace" | "external";
export type ConfirmationMode = "none" | "explicit_request" | "argument" | "workflow";

/** Thrown for a registry invariant violation; messages match the Python `ValueError` texts. */
export class ToolRegistryError extends Error {}

export interface ToolSpecFields {
  readonly name: string;
  readonly category: ToolCategory;
  readonly commands?: readonly string[];
  readonly skills?: readonly string[];
  readonly defaultExposed?: boolean;
  readonly discoverable?: boolean;
  readonly discoveryKeywords?: readonly string[];
  readonly discoverySummary?: string;
  readonly requiresDataSource?: boolean;
  readonly concurrencySafe?: boolean;
  readonly executionMode?: ExecutionMode;
  readonly jobThreshold?: string;
  readonly requiresRuntime?: boolean;
  readonly requiresWorkspace?: boolean;
  /** Omitted means the category default: `workspace` for write/output, otherwise `none`. */
  readonly sideEffect?: SideEffectScope;
  readonly confirmation?: ConfirmationMode;
}

export class ToolSpec {
  readonly name: string;
  readonly category: ToolCategory;
  readonly defaultExposed: boolean;
  readonly discoverable: boolean;
  readonly discoveryKeywords: ReadonlySet<string>;
  readonly discoverySummary: string;
  readonly commands: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
  readonly requiresDataSource: boolean;
  readonly concurrencySafe: boolean;
  readonly executionMode: ExecutionMode;
  readonly jobThreshold: string;
  readonly requiresRuntime: boolean;
  readonly requiresWorkspace: boolean;
  readonly sideEffect: SideEffectScope;
  readonly confirmation: ConfirmationMode;

  constructor(fields: ToolSpecFields) {
    this.name = fields.name;
    this.category = fields.category;
    this.defaultExposed = fields.defaultExposed ?? true;
    this.discoverable = fields.discoverable ?? false;
    this.discoveryKeywords = new Set(fields.discoveryKeywords ?? []);
    this.discoverySummary = fields.discoverySummary ?? "";
    this.commands = new Set(fields.commands ?? []);
    this.skills = new Set(fields.skills ?? []);
    this.requiresDataSource = fields.requiresDataSource ?? false;
    this.concurrencySafe = fields.concurrencySafe ?? false;
    this.executionMode = fields.executionMode ?? "sync";
    this.jobThreshold = fields.jobThreshold ?? "";
    this.requiresRuntime = fields.requiresRuntime ?? false;
    this.requiresWorkspace = fields.requiresWorkspace ?? false;
    this.sideEffect =
      fields.sideEffect ?? (fields.category === "write" || fields.category === "output" ? "workspace" : "none");
    this.confirmation = fields.confirmation ?? "none";
  }

  /** `name` plus every keyword: what the discovery scan looks for in a normalized query. */
  get discoveryTerms(): ReadonlySet<string> {
    return new Set([this.name, ...this.discoveryKeywords]);
  }

  isExposed(options: {
    command?: string;
    hasDataSource?: boolean;
    hasWorkspace?: boolean;
    skill?: string;
    discovered?: boolean;
  } = {}): boolean {
    if (this.requiresDataSource && options.hasDataSource !== true) return false;
    if (this.requiresWorkspace && options.hasWorkspace !== true) return false;
    const command = options.command ?? "";
    const skill = options.skill ?? "";
    return (
      this.defaultExposed ||
      (command !== "" && this.commands.has(command)) ||
      (skill !== "" && this.skills.has(skill)) ||
      (this.discoverable && options.discovered === true)
    );
  }
}

export class ToolRegistry {
  private readonly specsByName: Map<string, ToolSpec> = new Map();

  constructor(specs: Iterable<ToolSpec>) {
    for (const spec of specs) {
      if (!spec.name) throw new ToolRegistryError("tool name cannot be empty");
      if (this.specsByName.has(spec.name)) {
        throw new ToolRegistryError(`duplicate tool spec: ${spec.name}`);
      }
      if (spec.executionMode === "auto" && !spec.jobThreshold) {
        throw new ToolRegistryError(`auto tool requires job_threshold: ${spec.name}`);
      }
      if (spec.discoverable && (spec.discoveryKeywords.size === 0 || !spec.discoverySummary)) {
        throw new ToolRegistryError(`discoverable tool requires keywords and summary: ${spec.name}`);
      }
      if (spec.concurrencySafe && spec.sideEffect !== "none") {
        throw new ToolRegistryError(`concurrency-safe tool cannot declare side effects: ${spec.name}`);
      }
      if (spec.confirmation !== "none" && spec.sideEffect === "none") {
        throw new ToolRegistryError(`confirmation requires a side-effect scope: ${spec.name}`);
      }
      if (spec.sideEffect === "external" && spec.confirmation === "none") {
        throw new ToolRegistryError(`external side effect requires confirmation policy: ${spec.name}`);
      }
      this.specsByName.set(spec.name, spec);
    }
  }

  get(name: string): ToolSpec | undefined {
    return this.specsByName.get(name);
  }

  all(): readonly ToolSpec[] {
    return [...this.specsByName.values()];
  }

  names(): ReadonlySet<string> {
    return new Set(this.specsByName.keys());
  }

  exposedNames(options: {
    command?: string;
    hasDataSource?: boolean;
    hasWorkspace?: boolean;
    skill?: string;
    discoveredTools?: Iterable<string>;
  } = {}): Set<string> {
    const discovered = new Set(options.discoveredTools ?? []);
    const exposed = new Set<string>();
    for (const spec of this.specsByName.values()) {
      if (
        spec.isExposed({
          command: options.command ?? "",
          hasDataSource: options.hasDataSource === true,
          hasWorkspace: options.hasWorkspace === true,
          skill: options.skill ?? "",
          discovered: discovered.has(spec.name),
        })
      ) {
        exposed.add(spec.name);
      }
    }
    return exposed;
  }

  /** Fail when the prompt-facing schemas and this table disagree about which tools exist. */
  validateSchemaNames(schemas: Iterable<{ function?: { name?: string } | null }>): void {
    const schemaNames = new Set<string>();
    for (const schema of schemas) {
      const name = (schema.function?.name ?? "").trim();
      if (name) schemaNames.add(name);
    }
    const known = this.names();
    const missingSpecs = [...schemaNames].filter((name) => !known.has(name)).sort(pyCompare);
    const missingSchemas = [...known].filter((name) => !schemaNames.has(name)).sort(pyCompare);
    if (missingSpecs.length === 0 && missingSchemas.length === 0) return;
    const details: string[] = [];
    if (missingSpecs.length > 0) details.push(`missing specs=${pyRepr(missingSpecs)}`);
    if (missingSchemas.length > 0) details.push(`missing schemas=${pyRepr(missingSchemas)}`);
    throw new ToolRegistryError("tool registry/schema mismatch: " + details.join("; "));
  }
}

const SPECS: readonly ToolSpec[] = [
  new ToolSpec({ name: "workspace_status", category: "read", requiresRuntime: true }),
  new ToolSpec({
    name: "browse_webpage",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "http://", "https://", "url", "网页", "链接", "website", "web page",
      "api 文档", "接口文档", "webhook", "docs", "documentation",
    ],
    discoverySummary: "Fetch a public HTTP(S) webpage and return bounded readable text.",
  }),
  new ToolSpec({
    name: "browser_search",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "搜索", "search", "调研", "research", "google", "百度", "bing",
      "查一下", "查找", "浏览器搜索",
    ],
    discoverySummary: "Search the web in a visible browser and return results.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "browser_navigate",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["打开网址", "navigate", "访问网页", "go to url", "打开网页"],
    discoverySummary: "Navigate the visible browser to a URL.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "browser_click",
    category: "interaction",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["网页点击", "点击网页", "点击按钮", "点击链接", "click button", "click link", "browser click"],
    discoverySummary: "Click an element in the visible browser.",
    sideEffect: "external",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "browser_fill",
    category: "interaction",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["网页输入", "填写表单", "输入框", "browser fill", "type into"],
    discoverySummary: "Fill an input field in the visible browser.",
    sideEffect: "external",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "browser_extract",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["提取网页", "extract text", "网页内容", "page content"],
    discoverySummary: "Extract visible text from the current browser page.",
  }),
  new ToolSpec({
    name: "browser_screenshot",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["截图", "screenshot", "网页截图"],
    discoverySummary: "Take a screenshot of the current browser page.",
    sideEffect: "workspace",
  }),
  new ToolSpec({
    name: "browser_close",
    category: "interaction",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["关闭浏览器", "close browser"],
    discoverySummary: "Close the visible browser window.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "fetch_table",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    skills: ["web-table"],
    discoveryKeywords: [
      "网页表格", "抓取表格", "抓下来", "爬取表格", "网页数据", "导入网址",
      "在线表格", "解析pdf", "pdf 表格", "json 接口", "csv 链接",
      "fetch table", "scrape table", "web table", "web scrape", "pdf table",
    ],
    discoverySummary: "Fetch a URL (HTML/JSON/CSV/PDF) and register its tables as a queryable data source.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "browser_extract_tables",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    skills: ["web-table"],
    discoveryKeywords: [
      "动态网页表格", "动态表格", "js 渲染表格", "浏览器表格", "网页表格提取",
      "dynamic table", "javascript table", "browser tables", "rendered table",
    ],
    discoverySummary: "Extract <table> elements from the live browser page and register them as a data source.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "configure_hooks",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "hooks", "hook", "webhook", "自动配置", "帮我配置", "配置这个",
      "配置hook", "配置 hooks", "hook配置", "hook config",
    ],
    discoverySummary: "Validate and save user Hooks configuration proposed by the model.",
    sideEffect: "workspace",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "create_feishu_bitable",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    skills: ["feishu-bitable"],
    discoveryKeywords: [
      "飞书多维表格", "多维表格", "bitable", "base 表格", "创建飞书表格",
      "新建飞书表格", "创建多维表", "新建多维表",
    ],
    discoverySummary:
      "Create a Feishu Bitable with a named table, text fields, and optional initial records through the configured application bot.",
    sideEffect: "external",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "list_feishu_bitable_tables",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    skills: ["feishu-bitable"],
    discoveryKeywords: ["飞书多维表格", "bitable", "多维表格数据表", "表格列表", "读取飞书表格"],
    discoverySummary: "List data tables visible to the configured Feishu application bot in one Bitable.",
  }),
  new ToolSpec({
    name: "load_feishu_bitable",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    skills: ["feishu-bitable"],
    discoveryKeywords: ["分析飞书表格", "读取飞书表格", "飞书多维表格", "bitable", "多维表格分析"],
    discoverySummary:
      "Read a bounded Feishu Bitable table into the current conversation as an analyzable data source.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "append_feishu_bitable_records",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    skills: ["feishu-bitable"],
    discoveryKeywords: ["写入飞书表格", "回写飞书表格", "追加多维表格", "append bitable"],
    discoverySummary: "Append explicitly requested records to an existing Feishu Bitable table.",
    sideEffect: "external",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "update_feishu_bitable_record",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    skills: ["feishu-bitable"],
    discoveryKeywords: ["更新飞书表格", "编辑飞书表格", "修改多维表格", "update bitable"],
    discoverySummary: "Update one explicitly identified Feishu Bitable record using a record ID returned by a read.",
    sideEffect: "external",
    confirmation: "explicit_request",
  }),
  new ToolSpec({ name: "read_tool_result", category: "read" }),
  new ToolSpec({ name: "search_mcp_tools", category: "read" }),
  new ToolSpec({ name: "query_knowledge", category: "read", concurrencySafe: true }),
  new ToolSpec({ name: "get_schema", category: "read", requiresDataSource: true }),
  new ToolSpec({ name: "get_table_detail", category: "read", requiresDataSource: true, concurrencySafe: true }),
  new ToolSpec({
    name: "create_analysis_table",
    category: "write",
    requiresDataSource: true,
    executionMode: "auto",
    jobThreshold: "workspace_persistent_ctas",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "delete_analysis_tables",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["删除表", "清理表", "drop table", "cleanup table", "analysis table cleanup"],
    discoverySummary: "Delete confirmed derived analysis tables while protecting source tables.",
    requiresDataSource: true,
    requiresRuntime: true,
    confirmation: "argument",
  }),
  new ToolSpec({
    name: "query_data",
    category: "read",
    requiresDataSource: true,
    executionMode: "auto",
    jobThreshold: "workspace_query_rows_gte_100000",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "run_analysis",
    category: "analysis",
    requiresDataSource: true,
    executionMode: "auto",
    jobThreshold: "time_series_rows_gte_1000",
    requiresRuntime: true,
  }),
  new ToolSpec({ name: "select_chart", category: "analysis", requiresDataSource: true, concurrencySafe: true }),
  new ToolSpec({
    name: "generate_chart",
    category: "output",
    requiresDataSource: true,
    executionMode: "auto",
    jobThreshold: "chart_rows_gte_50000",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "profile_data",
    category: "analysis",
    requiresDataSource: true,
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["profile", "profile_data", "数据概况", "数据画像", "字段分布", "数据质量"],
    discoverySummary: "Profile a table and produce distribution/quality summaries.",
    executionMode: "auto",
    jobThreshold: "profile_rows_gte_50000_or_columns_gte_50",
  }),
  new ToolSpec({
    name: "clean_data",
    category: "write",
    requiresDataSource: true,
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["clean", "clean_data", "清洗", "缺失值", "异常值", "winsorize", "trim"],
    discoverySummary: "Clean missing values, outliers, and related table-quality issues.",
    executionMode: "auto",
    jobThreshold: "clean_rows_gte_50000",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "export_excel",
    category: "output",
    defaultExposed: false,
    commands: ["excel_confirm"],
    executionMode: "auto",
    jobThreshold: "excel_bytes_gt_5mb",
    requiresRuntime: true,
    confirmation: "workflow",
  }),
  new ToolSpec({
    name: "export_report",
    category: "output",
    defaultExposed: false,
    commands: ["report_confirm"],
    executionMode: "auto",
    jobThreshold: "report_sections_gt_6_or_chart_count_gt_3",
    requiresRuntime: true,
    confirmation: "workflow",
  }),
  new ToolSpec({
    name: "propose_excel_export",
    category: "interaction",
    defaultExposed: false,
    commands: ["export", "excel_revise"],
    skills: ["export"],
  }),
  new ToolSpec({
    name: "propose_report_outline",
    category: "interaction",
    defaultExposed: false,
    commands: ["report", "report_revise"],
    skills: ["report"],
  }),
  new ToolSpec({
    name: "propose_ppt_outline",
    category: "interaction",
    defaultExposed: false,
    commands: ["ppt", "ppt_revise"],
    skills: ["ppt"],
  }),
  new ToolSpec({
    name: "generate_ppt",
    category: "output",
    defaultExposed: false,
    commands: ["ppt_confirm"],
    executionMode: "auto",
    jobThreshold: "ppt_slides_gt_5",
    requiresRuntime: true,
    confirmation: "workflow",
  }),
  new ToolSpec({
    name: "set_ppt_color_scheme",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["ppt color", "ppt颜色", "配色", "主题色", "color scheme"],
    discoverySummary: "Set the PPT color scheme preference.",
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "propose_dashboard_outline",
    category: "interaction",
    defaultExposed: false,
    commands: ["dashboard", "dashboard_revise"],
    skills: ["dashboard"],
  }),
  new ToolSpec({
    name: "generate_dashboard",
    category: "output",
    defaultExposed: false,
    commands: ["dashboard_confirm"],
    executionMode: "auto",
    jobThreshold: "dashboard_widgets_gt_4_or_total_widget_rows_gte_50000",
    requiresRuntime: true,
    confirmation: "workflow",
  }),
  new ToolSpec({ name: "ask_user", category: "interaction" }),
  new ToolSpec({
    name: "workspace_glob",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["workspace", "文件", "目录", "列文件", "list files", "glob", "查找文件"],
    discoverySummary: "List files in mounted/system workspace roots.",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "workspace_grep",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["grep", "搜索", "搜索文件", "查找文本", "全文搜索", "search files", "regex"],
    discoverySummary: "Search text files in workspace roots.",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "workspace_read_file",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "读取文件", "打开文件", "查看文件", "说明文件", "说明文档",
      "文档内容", "文件内容", "读一下", "看一下", "看下",
      "read", "read file", "open file", "view file", ".txt", ".doc", ".docx", "word 文档", "Word 文档",
    ],
    discoverySummary: "Read a bounded workspace text, Word or spreadsheet file.",
    requiresRuntime: true,
  }),
  new ToolSpec({
    name: "workspace_write_file",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["写文件", "新建文件", "保存文件", "write file", "create file"],
    discoverySummary: "Write a new file under writable workspace roots.",
    requiresRuntime: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workspace_edit_file",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["修改文件", "编辑文件", "替换文本", "edit file", "patch file"],
    discoverySummary: "Edit a previously read workspace file.",
    requiresRuntime: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workspace_delete_file",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["删除文件", "移除文件", "delete file", "rm file"],
    discoverySummary: "Delete one confirmed file from writable workspace roots.",
    requiresRuntime: true,
    confirmation: "argument",
  }),
  new ToolSpec({
    name: "workspace_move_file",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["移动文件", "重命名文件", "move file", "rename file"],
    discoverySummary: "Move or rename one workspace file.",
    requiresRuntime: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workspace_bash",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "bash", "shell", "命令行", "运行命令", "checksum", "json validate",
      "json_validate", "git diff", "git status", "git log", "python compile",
    ],
    discoverySummary: "Run the strongest restricted command facade in the mounted workspace.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({ name: "structured_output", category: "interaction", defaultExposed: false }),
  new ToolSpec({
    name: "load_analysis_skill",
    category: "read",
    defaultExposed: true,
    discoveryKeywords: ["分析技能", "load skill", "analysis skill", "sop", "流程"],
    discoverySummary: "Load a project analysis skill SOP body.",
  }),
  new ToolSpec({
    name: "task_create",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["任务", "待办", "task", "todo", "创建任务"],
    discoverySummary: "Create a persistent workspace task.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "task_get",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["任务", "task", "查看任务", "任务详情"],
    discoverySummary: "Read one workspace task.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  new ToolSpec({
    name: "task_list",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["任务", "待办", "task", "todo", "任务列表"],
    discoverySummary: "List persistent workspace tasks.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  new ToolSpec({
    name: "task_update",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["任务", "待办", "task", "更新任务", "完成任务"],
    discoverySummary: "Update a workspace task.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "team_create",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["团队", "team", "agent team", "创建团队", "团队协作"],
    discoverySummary: "Create a persistent workspace analyst team.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "team_delete",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["团队", "team", "删除团队"],
    discoverySummary: "Delete a workspace analyst team.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "team_list",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["团队", "team", "团队列表", "成员状态"],
    discoverySummary: "List workspace analyst teams and member statuses.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  new ToolSpec({
    name: "team_status",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["团队", "team", "团队状态", "成员状态", "团队里", "mailbox"],
    discoverySummary: "Read one workspace analyst team status and recent mailbox.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  new ToolSpec({
    name: "send_message",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["团队消息", "发消息", "send message", "mailbox", "收件箱"],
    discoverySummary: "Send a message to a workspace team member mailbox.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "agent_delegate",
    category: "analysis",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["delegate", "委派", "子任务", "团队分析", "团队协作", "agent delegate"],
    discoverySummary: "Delegate a bounded reasoning task to a workspace team member.",
    requiresRuntime: true,
    requiresWorkspace: true,
    sideEffect: "session",
  }),
  new ToolSpec({
    name: "team_plan_create",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "团队计划", "动态计划", "创建团队计划", "创建动态计划", "先建计划", "预览计划",
      "暂不执行", "不要执行", "dynamic plan",
    ],
    discoverySummary: "Create a bounded dynamic team plan without executing members.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "team_delegate",
    category: "analysis",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["parallel team", "并行团队", "并发团队", "批量委派", "切换到团队", "team delegate"],
    discoverySummary: "Delegate multiple bounded teammate tasks in parallel.",
    requiresRuntime: true,
    requiresWorkspace: true,
    sideEffect: "session",
  }),
  new ToolSpec({ name: "plan_complete", category: "interaction", defaultExposed: false }),
  new ToolSpec({
    name: "workflow_create",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "workflow", "工作流", "创建workflow", "创建 workflow", "创建工作流",
      "新建workflow", "新建 workflow", "新建工作流", "创建流程", "新建流程",
    ],
    discoverySummary: "Create and publish a standard AI-team analysis Workflow template.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workflow_create_custom",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["自定义 workflow", "自定义工作流", "自定义 agent", "agent workflow", "创建模板", "创建流程"],
    discoverySummary: "Create and publish a custom Agent Workflow defined in conversation.",
    requiresRuntime: true,
    requiresWorkspace: true,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workflow_list",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["workflow", "工作流", "流程", "场景", "可用流程"],
    discoverySummary: "List published Workflows in the mounted workspace.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  new ToolSpec({
    name: "workflow_start",
    category: "analysis",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["run workflow", "start workflow", "运行工作流", "启动工作流", "运行流程", "启动流程", "执行场景"],
    discoverySummary: "Start a published Workflow and return its durable Run status.",
    skills: ["workflow"],
    requiresRuntime: true,
    requiresWorkspace: true,
    sideEffect: "workspace",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "workflow_status",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: ["workflow status", "run status", "工作流状态", "流程状态", "运行状态"],
    discoverySummary: "Read and reconcile a durable Workflow Run.",
    requiresRuntime: true,
    requiresWorkspace: true,
  }),
  // ── Diagram / Canvas tools ──
  // Exposed via skills, but also discoverable so the agent can use them when the user mentions
  // canvas/diagram keywords without manually selecting a skill.
  new ToolSpec({
    name: "display_diagram",
    category: "output",
    defaultExposed: false,
    discoverable: true,
    skills: ["business-model-canvas", "bcg-matrix", "swot-analysis", "value-proposition"],
    discoveryKeywords: [
      "商业模式画布", "价值主张", "bcg", "swot", "画布", "canvas",
      "diagram", "四象限", "框架图", "战略图",
    ],
    discoverySummary:
      "Render a draw.io diagram (business model canvas, BCG, SWOT, value proposition) to the canvas drawer.",
    concurrencySafe: false,
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "edit_diagram",
    category: "write",
    defaultExposed: false,
    discoverable: true,
    skills: ["business-model-canvas", "bcg-matrix", "swot-analysis", "value-proposition"],
    discoveryKeywords: [
      "商业模式画布", "价值主张", "bcg", "swot", "画布", "canvas",
      "diagram", "四象限", "框架图", "修改画布", "编辑图形",
    ],
    discoverySummary: "Edit an existing draw.io diagram in the canvas drawer.",
    confirmation: "explicit_request",
  }),
  new ToolSpec({
    name: "get_diagram",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    skills: ["business-model-canvas", "bcg-matrix", "swot-analysis", "value-proposition"],
    discoveryKeywords: ["商业模式画布", "价值主张", "bcg", "swot", "画布", "canvas", "diagram", "查看图"],
    discoverySummary: "Retrieve the current draw.io XML from the canvas drawer.",
  }),
  new ToolSpec({
    name: "memory_read",
    category: "read",
    defaultExposed: false,
    discoverable: true,
    discoveryKeywords: [
      "memory", "记忆", "长期记忆", "偏好", "反馈", "preference", "remember",
      "previous preference", "之前说的", "上次提到",
    ],
    discoverySummary: "Read the full body of a named long-term memory record from the current scope.",
  }),
];

export const BUILTIN_TOOL_REGISTRY = new ToolRegistry(SPECS);

export function getToolSpec(name: string): ToolSpec | undefined {
  return BUILTIN_TOOL_REGISTRY.get(name);
}

export function isJobEligible(name: string): boolean {
  const spec = getToolSpec(name);
  return spec !== undefined && (spec.executionMode === "auto" || spec.executionMode === "job");
}
