/**
 * 飞书多维表格工具（4 个）：建表、列数据表、追加记录、更新单条记录。
 *
 * 旧实现在 `agent/agent.py` 的工具分派里直接调 `data/feishu_bitable_service.py`；这里改成
 * `defineTool`（参数 schema 与旧 `agent/tools/schemas.py` 逐字一致），错误文案沿用旧实现。
 *
 * 幂等：三个写操作先向持久账本 `claim` 一个键（pi-durable 的 `taskId`/`callId` + 负载指纹）：
 * - `done`：这次调用已经写过，直接返回上次的结果，绝不再写飞书；
 * - `unfinished`：上一次同一次调用停在写入之间，结果未知，报错让模型先读表确认，而不是重复写；
 * - `claimed`：正常写入，成功后 `complete`，失败则 `release`（允许下一次调用重试）。
 *
 * 读工具（列数据表）没有副作用，`replay: "safe"`：崩溃后重跑只会多读一次。
 */

import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { appendBitableRecords, createBitable, listBitableTables, updateBitableRecord } from "./bitable.ts";
import type { FeishuClient } from "./client.ts";
import { ledgerKey, type FeishuWriteLedger } from "./ledger.ts";
import { errorResult, makeAppTool, okResult, type AppTool, type AppToolDetails } from "../tools/app/types.ts";

/** 工具用到的飞书端口；`client`/`ledger` 在首次调用时初始化（配置与凭据都是懒加载的）。 */
export type FeishuToolDeps = {
  connections(): Promise<{ client: FeishuClient; ledger: FeishuWriteLedger }>;
};

/** 账本键里的调用身份；测试可以注入固定值。 */
type CallIdentity = { taskId?: string; callId?: string };

function identityOf(api: ToolExecutionApi | undefined): CallIdentity | undefined {
  const callId = api?.callId;
  const taskId = api?.taskId === undefined ? undefined : String(api.taskId);
  if (typeof callId !== "string" || callId === "") return undefined;
  return { callId, ...(taskId === undefined ? {} : { taskId }) };
}

type ToolOk = { output: { type: "text"; text: string }[]; details: AppToolDetails };
type ToolErr = { isError: true; output: { type: "text"; text: string }[]; details: AppToolDetails };

/** 账本里存下的结果（`{ text, details }`）；形状不对时返回 undefined。 */
function replayOf(stored: unknown): { text: string; details: AppToolDetails } | undefined {
  if (typeof stored !== "object" || stored === null) return undefined;
  if (!("text" in stored) || typeof stored.text !== "string") return undefined;
  const details =
    "details" in stored && typeof stored.details === "object" && stored.details !== null
      ? // 账本是我们自己写的 JSON，字段形状由 `writeOnce` 保证。
        (stored.details as AppToolDetails)
      : {};
  return { text: stored.text, details };
}

/**
 * 跑一次写操作，并让它在同一次 durable 调用内最多生效一次。
 *
 * 没有 durable 调用身份时（单元测试、无 Harness 的嵌入场景）不启用账本，直接写。
 */
async function writeOnce(
  deps: FeishuToolDeps,
  tool: string,
  api: ToolExecutionApi | undefined,
  payload: unknown,
  perform: (client: FeishuClient) => Promise<Record<string, unknown> & { message: string }>,
): Promise<ToolOk | ToolErr> {
  const { client, ledger } = await deps.connections();
  const identity = identityOf(api);
  if (identity === undefined) {
    const value = await perform(client);
    return okResult(tool, JSON.stringify({ ok: true, ...value }), { tool, ...(value as AppToolDetails) });
  }

  const key = ledgerKey(tool, identity, payload);
  const claim = await ledger.claim(key, tool);
  if (claim.kind === "done") {
    const replay = replayOf(claim.entry.value);
    if (replay === undefined) {
      return errorResult(tool, "飞书写入已执行过，但记录的结果已损坏；请读取目标表确认后再重试。");
    }
    return { output: [{ type: "text", text: replay.text }], details: { ...replay.details, deduplicated: true } };
  }
  if (claim.kind === "unfinished") {
    return errorResult(
      tool,
      "飞书多维表格写入的上一次尝试未完成，结果未知；为避免重复写入已停止，请先读取目标表确认后再重试。",
    );
  }
  try {
    const value = await perform(client);
    const details: AppToolDetails = { tool, ...(value as AppToolDetails) };
    await ledger.complete(key, tool, { text: JSON.stringify({ ok: true, ...value }), details });
    return { output: [{ type: "text", text: JSON.stringify({ ok: true, ...value }) }], details };
  } catch (error) {
    await ledger.release(key).catch(() => undefined);
    throw error;
  }
}

export function createFeishuTools(deps: FeishuToolDeps): AppTool[] {
  return [
    makeAppTool<{ bitable: string }>({
      name: "list_feishu_bitable_tables",
      description:
        "List tables that the configured Feishu application bot can access in a Bitable. " +
        "Use this before reading when the user provides an app-level Bitable link without a table ID. " +
        "This is read-only; accept a Feishu Bitable URL or app_token.",
      parameters: {
        type: "object",
        properties: {
          bitable: { type: "string", description: "Feishu Bitable URL or app_token." },
        },
        required: ["bitable"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const { client } = await deps.connections();
          const result = await listBitableTables(client, { bitable: args.bitable });
          return okResult("list_feishu_bitable_tables", JSON.stringify({ ok: true, ...result }), {
            tool: "list_feishu_bitable_tables",
            app_token: result.app_token,
            tables: result.tables,
          });
        } catch (error) {
          return errorResult("list_feishu_bitable_tables", messageOf(error));
        }
      },
    }),

    makeAppTool<{
      name: string;
      table_name: string;
      fields: string[];
      records?: Record<string, unknown>[];
      folder_token?: string;
    }>({
      name: "create_feishu_bitable",
      description:
        "Create a NEW Feishu Bitable and one data table using the configured Feishu application bot. " +
        "Call only when the user explicitly asks to create a Feishu Bitable/table; this is an external write. " +
        "Use short, meaningful Chinese field names. All created fields are safe plain-text fields. " +
        "Optional records must use only the supplied field names. Return the generated Feishu URL to the user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the new Feishu Bitable." },
          table_name: { type: "string", description: "Name of the first data table." },
          fields: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string" },
            description: "Ordered column names for the data table.",
          },
          records: {
            type: "array",
            maxItems: 500,
            items: { type: "object", additionalProperties: {} },
            description: "Optional initial records. Each key must be one of fields.",
          },
          folder_token: {
            type: "string",
            description: "Optional target Feishu folder token. Omit to use the application-visible root folder.",
          },
        },
        required: ["name", "table_name", "fields"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          return await writeOnce(deps, "create_feishu_bitable", api, args, async (client) => ({
            message: "飞书多维表格已创建。请把 url 作为可点击链接交付给用户。",
            ...(await createBitable(client, {
              name: args.name,
              tableName: args.table_name,
              fields: args.fields ?? [],
              records: args.records ?? [],
              folderToken: args.folder_token ?? "",
            })),
          }));
        } catch (error) {
          return errorResult("create_feishu_bitable", messageOf(error));
        }
      },
    }),

    makeAppTool<{ bitable: string; table_id: string; records: Record<string, unknown>[] }>({
      name: "append_feishu_bitable_records",
      description:
        "Append records to an EXISTING Feishu Bitable table. This is an external write: call it only after the " +
        "user explicitly asks to write these exact results back. Use field names that already exist in the target table.",
      parameters: {
        type: "object",
        properties: {
          bitable: { type: "string", description: "Feishu Bitable URL or app_token." },
          table_id: { type: "string", description: "Target table ID when absent from the URL." },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "object", additionalProperties: {} },
            description: "Exact records to append.",
          },
        },
        required: ["bitable", "table_id", "records"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          return await writeOnce(deps, "append_feishu_bitable_records", api, args, async (client) => ({
            message: "分析结果已追加写入飞书多维表格。请把 url 作为可点击链接交付给用户。",
            ...(await appendBitableRecords(client, {
              bitable: args.bitable,
              tableId: args.table_id,
              records: args.records ?? [],
            })),
          }));
        } catch (error) {
          return errorResult("append_feishu_bitable_records", messageOf(error));
        }
      },
    }),

    makeAppTool<{ bitable: string; table_id: string; record_id: string; fields: Record<string, unknown> }>({
      name: "update_feishu_bitable_record",
      description:
        "Update one EXISTING Feishu Bitable record. This is an external write: call it only after explicit user approval. " +
        "Use a record_id returned by load_feishu_bitable, never guess one.",
      parameters: {
        type: "object",
        properties: {
          bitable: { type: "string", description: "Feishu Bitable URL or app_token." },
          table_id: { type: "string", description: "Target table ID when absent from the URL." },
          record_id: { type: "string", description: "Exact record ID returned by a prior Bitable read." },
          fields: { type: "object", additionalProperties: {}, description: "Exact field values to update." },
        },
        required: ["bitable", "table_id", "record_id", "fields"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          return await writeOnce(deps, "update_feishu_bitable_record", api, args, async (client) => ({
            message: "飞书多维表格记录已更新。请把 url 作为可点击链接交付给用户。",
            ...(await updateBitableRecord(client, {
              bitable: args.bitable,
              tableId: args.table_id,
              recordId: args.record_id,
              fields: args.fields ?? {},
            })),
          }));
        } catch (error) {
          return errorResult("update_feishu_bitable_record", messageOf(error));
        }
      },
    }),
  ];
}

/** 工具失败文案：飞书的错误类都带用户可读的中文消息，原样交给模型。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
