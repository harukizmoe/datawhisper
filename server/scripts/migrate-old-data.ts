/**
 * 旧版数据迁移：把老应用留在 `<旧数据根>/outputs` 下的内容搬进新应用的数据目录。
 *
 *   旧会话   `outputs/Session` 下的 json        → pi-durable 会话（每条问答一个 entry）+ `library.sqlite` 标题
 *   旧 job   `outputs/jobs/jobs.db`             → `library.sqlite` 的 `archive_jobs`（只读归档，不重跑）
 *   旧运行   `outputs` 下任意层级的 `runs.db`   → `library.sqlite` 的 `archive_runs` / `archive_node_runs`
 *
 * 只做「导入」：不删除旧文件、不改旧库，`--dry-run` 打印将要写入的内容。重复执行是安全的：
 * 每个导入项都带 `source`（旧文件的相对路径或旧主键）做唯一键，已导入的跳过。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness as HarnessClass } from "@earendil-works/pi-durable";
import { LibraryStore } from "../src/library/store.ts";

export type MigrateOptions = {
  /** 旧数据根：默认是仓库根（旧版源码模式就把数据写在这里）。 */
  readonly from: string;
  /** 新数据目录（`datawhisper.sqlite`、`library.sqlite` 所在）。 */
  readonly to: string;
  readonly dryRun?: boolean;
};

export type MigrateReport = {
  sessions: { file: string; conversationId?: number; messages: number; skipped?: string }[];
  jobs: { imported: number; skipped: number; files: string[] };
  runs: { imported: number; nodes: number; files: string[] };
};

/** 旧会话 JSON 里我们真正会用的字段；其余（工作区、恢复态）只记进 entry 的 data 便于排查。 */
type OldSession = {
  name?: string;
  saved_at?: string;
  session_id?: string;
  model_provider?: string;
  history?: OldMessage[];
  total_input_tokens?: number;
  total_output_tokens?: number;
  data_source?: unknown;
  workspace?: unknown;
};

type OldMessage = {
  role?: string;
  content?: unknown;
  reasoning?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  chart_ids?: string[];
};

/** 旧正文可能是字符串，也可能是 [{"type":"text","text":…}] 的分块数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const block of content) {
    if (typeof block === "string") pieces.push(block);
    else if (typeof block === "object" && block !== null) {
      const value = block as { type?: string; text?: string };
      if (value.type === "text" && typeof value.text === "string") pieces.push(value.text);
    }
  }
  return pieces.join("\n");
}

/**
 * 旧历史 → pi-durable 的 entry 草稿。
 *
 * 只迁「人看得见」的部分：用户消息、带正文的助手消息、以及工具调用/结果的摘要。
 * 旧 history 里没有可靠的时间戳，`saved_at` 只用来给整段会话一个起点。
 */
export function sessionEntries(session: OldSession): { kind: string; model?: unknown[]; data?: unknown }[] {
  const entries: { kind: string; model?: unknown[]; data?: unknown }[] = [];
  const history = Array.isArray(session.history) ? session.history : [];
  for (const message of history) {
    const role = message.role;
    if (role === "system") continue;
    if (role === "user") {
      const text = textOf(message.content);
      if (text.trim() === "") continue;
      entries.push({ kind: "pi.user", model: [{ role: "user", content: text }] });
      continue;
    }
    if (role === "assistant") {
      const text = textOf(message.content);
      const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (text.trim() === "" && calls.length === 0 && reasoning.trim() === "") continue;
      const content: Record<string, unknown>[] = [];
      if (text.trim() !== "") content.push({ type: "text", text });
      for (const call of calls) {
        const name = call.function?.name ?? "";
        if (name === "") continue;
        // 工具参数在旧版是 JSON 字符串；解析失败就原样保留，迁移不能因为一条坏参数停下。
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          input = { raw: call.function?.arguments ?? "" };
        }
        content.push({ type: "tool-call", id: call.id ?? "", name, input });
      }
      entries.push({
        kind: "pi.assistant",
        model: [{ role: "assistant", content: content.length > 0 ? content : "", ...(reasoning === "" ? {} : { reasoning }) }],
      });
      continue;
    }
    if (role === "tool") {
      const text = textOf(message.content);
      entries.push({
        kind: "pi.tool-result",
        model: [
          {
            role: "tool",
            toolCallId: message.tool_call_id ?? "",
            content: text,
          },
        ],
        ...(Array.isArray(message.chart_ids) && message.chart_ids.length > 0 ? { data: { chart_ids: message.chart_ids } } : {}),
      });
    }
  }
  return entries;
}

/** 归档表：旧 job 与旧工作流运行只作为历史记录展示，不参与调度。 */
function ensureArchiveSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_jobs (
      source      TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL DEFAULT '',
      label       TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT '',
      progress    REAL,
      message     TEXT NOT NULL DEFAULT '',
      result      TEXT,
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT '',
      started_at  TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS archive_runs (
      source              TEXT PRIMARY KEY,
      workflow_version_id TEXT NOT NULL DEFAULT '',
      workspace_id        TEXT NOT NULL DEFAULT '',
      session_id          TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT '',
      started_by          TEXT NOT NULL DEFAULT '',
      started_at          TEXT NOT NULL DEFAULT '',
      finished_at         TEXT,
      failure_code        TEXT NOT NULL DEFAULT '',
      failure_message     TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS archive_node_runs (
      source      TEXT PRIMARY KEY,
      run_source  TEXT NOT NULL,
      node_id     TEXT NOT NULL DEFAULT '',
      iteration   INTEGER NOT NULL DEFAULT 1,
      attempt     INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT '',
      output      TEXT,
      error       TEXT
    );
  `);
}

/** 递归找出所有 `runs.db`（旧版按工作区分目录存放运行记录）。 */
function findFiles(root: string, name: string, depth = 4): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, level + 1);
      else if (entry.name === name) found.push(path);
    }
  };
  walk(root, 0);
  return found.sort();
}

/** 读旧库里存在的表与列；旧版本字段有增删，缺列按空值处理。 */
function readRows(dbPath: string, table: string): Record<string, unknown>[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as unknown;
    if (exists === null || exists === undefined) return [];
    return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
/** 旧库里 JSON 列多数已经是文本；只有对象/数组才需要再序列化，避免二次编码。 */
const jsonColumn = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

export async function migrateOldData(options: MigrateOptions): Promise<MigrateReport> {
  const from = resolve(options.from);
  const to = resolve(options.to);
  const report: MigrateReport = {
    sessions: [],
    jobs: { imported: 0, skipped: 0, files: [] },
    runs: { imported: 0, nodes: 0, files: [] },
  };
  const sessionDir = join(from, "outputs", "Session");
  const files = existsSync(sessionDir)
    ? readdirSync(sessionDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];

  if (options.dryRun !== true) mkdirSync(to, { recursive: true });
  // 迁移也需要会话存储：直接开一份 Harness，与 `startService` 用的是同一个数据库文件。
  const harness: Harness =
    options.dryRun === true
      ? (undefined as unknown as Harness)
      : await HarnessClass.open(
          await openNodeSqliteStorage(join(to, "datawhisper.sqlite")),
          {
            // 迁移不需要模型：会话只写历史 entry，不发起任何请求。Harness 仍要求一个模型目录对象。
            models: createModels(),
            registry: createRegistry(),
            identity: { attribution: null },
          } as never,
          context,
        );
  const library = options.dryRun === true ? undefined : new LibraryStore(join(to, "library.sqlite"));
  const archive = options.dryRun === true ? undefined : new Database(join(to, "library.sqlite"));
  if (archive !== undefined) archive.exec("PRAGMA journal_mode = WAL");
  if (archive !== undefined) ensureArchiveSchema(archive);

  try {
    for (const name of files) {
      const path = join(sessionDir, name);
      let session: OldSession;
      try {
        session = JSON.parse(readFileSync(path, "utf8")) as OldSession;
      } catch (error) {
        report.sessions.push({ file: name, messages: 0, skipped: `unreadable: ${(error as Error).message}` });
        continue;
      }
      const entries = sessionEntries(session);
      if (entries.length === 0) {
        report.sessions.push({ file: name, messages: 0, skipped: "no messages" });
        continue;
      }
      if (options.dryRun === true) {
        report.sessions.push({ file: name, messages: entries.length });
        continue;
      }
      const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      const conversationId = created.id as unknown as number;
      // 逐条 append：`commit` 里按顺序写，entry id 自然递增，fork/上下文语义与正常对话一致。
      await created.commit(async (tx) => {
        for (const entry of entries) {
          await tx.appendEntry(conversationId as unknown as ConversationId, entry as never);
        }
      }, context);
      const title = str(session.name) !== "" ? str(session.name) : `对话 ${name.replace(/\.json$/, "")}`;
      const savedAt = str(session.saved_at) !== "" ? str(session.saved_at) : new Date().toISOString();
      // 标题只走 `session_meta`：旧会话名是用户给的，不该靠首条消息猜。
      library?.putMeta(String(conversationId), { title });
      report.sessions.push({ file: name, conversationId, messages: entries.length });
    }

    // 旧 job 记录：整表读出来一条条进归档；主键沿用旧 id 加来源前缀，重复执行只导入一次。
    const jobsDb = join(from, "outputs", "jobs", "jobs.db");
    if (existsSync(jobsDb)) {
      report.jobs.files.push(relative(from, jobsDb));
      for (const row of readRows(jobsDb, "jobs")) {
        const source = `jobs.db:${str(row.id)}`;
        if (options.dryRun === true) {
          report.jobs.imported += 1;
          continue;
        }
        const changed = archive!
          .query(
            `INSERT OR IGNORE INTO archive_jobs
               (source, session_id, type, label, status, progress, message, result, error, created_at, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            source,
            str(row.session_id),
            str(row.type),
            str(row.label),
            str(row.status),
            num(row.progress),
            str(row.message),
            jsonColumn(row.result),
            jsonColumn(row.error),
            str(row.created_at),
            row.started_at === null ? null : str(row.started_at),
            row.finished_at === null ? null : str(row.finished_at),
          );
        if (changed.changes > 0) report.jobs.imported += 1;
        else report.jobs.skipped += 1;
      }
    }

    for (const runsDb of findFiles(join(from, "outputs"), "runs.db")) {
      report.runs.files.push(relative(from, runsDb));
      const nodes = readRows(runsDb, "workflow_node_runs");
      for (const row of readRows(runsDb, "workflow_runs")) {
        const source = `${relative(from, runsDb)}:${str(row.id)}`;
        if (options.dryRun !== true) {
          archive!
            .query(
              `INSERT OR IGNORE INTO archive_runs
                 (source, workflow_version_id, workspace_id, session_id, status, started_by, started_at, finished_at, failure_code, failure_message)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              source,
              str(row.workflow_version_id),
              str(row.workspace_id),
              str(row.session_id),
              str(row.status),
              str(row.started_by),
              str(row.started_at),
              row.finished_at === null ? null : str(row.finished_at),
              str(row.failure_code),
              str(row.failure_message),
            );
          report.runs.imported += 1;
        } else {
          report.runs.imported += 1;
        }
        for (const node of nodes.filter((candidate) => str(candidate.run_id) === str(row.id))) {
          const nodeSource = `${relative(from, runsDb)}:${str(node.id)}`;
          if (options.dryRun === true) {
            report.runs.nodes += 1;
            continue;
          }
          const changed = archive!
            .query(
              `INSERT OR IGNORE INTO archive_node_runs
                 (source, run_source, node_id, iteration, attempt, status, output, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              nodeSource,
              source,
              str(node.node_id),
              typeof node.iteration === "number" ? node.iteration : 1,
              typeof node.attempt === "number" ? node.attempt : 1,
              str(node.status),
              jsonColumn(node.output_json),
              node.error === null || node.error === undefined ? null : str(node.error),
            );
          if (changed.changes > 0) report.runs.nodes += 1;
        }
      }
    }
  } finally {
    library?.close();
    archive?.close();
    // Harness 的关闭要带上下文；迁移是一次性的，关掉它释放 sqlite 句柄。
    if (harness !== undefined) await harness.close(context);
  }
  return report;
}

/** 命令行入口：`bun run scripts/migrate-old-data.ts --from <旧数据根> --to <新数据目录> [--dry-run]`。 */
async function main(argv: string[]): Promise<void> {
  const arg = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
  };
  const from = arg("from", resolve(import.meta.dir, "../.."));
  const to = arg("to", join(process.env.HOME ?? ".", ".local", "share", "datawhisper"));
  const dryRun = argv.includes("--dry-run");
  const report = await migrateOldData({ from, to, dryRun });
  const sessions = report.sessions.filter((item) => item.skipped === undefined).length;
  console.log(`会话：导入 ${sessions} 个，跳过 ${report.sessions.length - sessions} 个`);
  for (const item of report.sessions) {
    console.log(`  ${item.file} → ${item.conversationId === undefined ? "（dry-run）" : `会话 ${item.conversationId}`} · ${item.messages} 条${item.skipped === undefined ? "" : ` · ${item.skipped}`}`);
  }
  console.log(`job 记录：导入 ${report.jobs.imported}，已存在 ${report.jobs.skipped}`);
  console.log(`工作流运行：导入 ${report.runs.imported}，节点 ${report.runs.nodes}`);
  if (dryRun) console.log("（dry-run：没有写入任何文件）");
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

