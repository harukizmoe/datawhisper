/**
 * `fetch_table` 与 `load_feishu_bitable`：把「网页 / 文件链接 / 飞书多维表格」变成会话里可查询的数据来源。
 *
 * 分工：这里负责取字节（带 SSRF 校验与大小上限）与说话；解析、落盘与登记来源都交给
 * `AppToolDeps.ingest`（由 `sourceMethods` 装配时填入，它持有会话文档、compute 与上传目录）。
 * 解析与落盘都在 compute：抓来的表会写成 CSV，所以重启后仍然打得开。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readBitableRecords } from "../../feishu/bitable.ts";
import { defaultFeishuService } from "../../feishu/service.ts";
import { errorResult, makeAppTool, okResult, type AppTool, type AppToolDeps, type AppToolDetails, type IngestedTable } from "./types.ts";
import { ipv4Private, ipv6Private, validateUrl } from "./web.ts";

/** 一次抓取最多读这么多字节；compute 侧的解析上限更小，超出会在那边报 FETCH-002。 */
const MAX_FETCH_BYTES = 12 * 1024 * 1024;

/** 网址解析到私网地址时拒绝：DNS 层也要查，不能只信 URL 里的字面量。 */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname;
  if (isIP(host) !== 0) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`cannot resolve URL host: ${host}`);
  }
  if (addresses.some(({ address }) => ipv4Private(address) || ipv6Private(address))) {
    throw new Error("local/private network URLs are not allowed");
  }
}

/** 工具只在会话里跑：拿不到会话 id 时说清楚，而不是去读「第 NaN 个对话」的文档。 */
function conversationIdOf(api: { conversationId: number | string | undefined }): number {
  const id = Number(api.conversationId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("This tool needs an open conversation.");
  return id;
}

/** 登记结果压成模型能读的一行：来源名 + 表名。 */
function summarize(tool: string, text: string, added: readonly IngestedTable[]): AppToolDetails {
  return {
    tool,
    sources: added.map((item) => ({ name: item.name, tables: [...item.tables] })),
    tableCount: added.reduce((total, item) => total + item.tables.length, 0),
  };
}

export function createIngestTools(deps: AppToolDeps): AppTool[] {
  const fetchImpl = deps.fetch ?? fetch;
  const feishu = deps.feishu ?? defaultFeishuService();
  return [
    makeAppTool<{ url: string; source_name?: string }>({
      name: "fetch_table",
      description:
        "Fetch a public URL (HTML page, JSON API, CSV file, PDF or Excel) and attach every table it contains " +
        "to this conversation as a queryable data source. Use it when the user sends a link and wants that " +
        "data analyzed. Local/private network URLs are blocked. After it succeeds, continue with get_schema " +
        "and the normal SQL/analysis tools; never invent table contents.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute public http:// or https:// URL." },
          source_name: { type: "string", description: "Optional display name for the attached data source." },
        },
        required: ["url"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          if (deps.ingest === undefined) throw new Error("Table ingestion is not available in this build.");
          const url = validateUrl(args.url ?? "");
          await assertPublicHost(url);
          const response = await fetchImpl(url.toString(), {
            headers: {
              "User-Agent": "DataWhisper/1.0 (+fetch_table)",
              Accept: "text/html,application/json,text/csv,application/pdf,*/*;q=0.8",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(30_000),
          });
          // 重定向之后可能换了主机：最终地址也要过了私网校验。
          await assertPublicHost(new URL(response.url === "" ? url.toString() : response.url));
          if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.toString()}`);
          const body = new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_FETCH_BYTES);
          if (body.byteLength === 0) throw new Error("The URL returned an empty body.");
          const result = await deps.ingest.fetchTables(conversationIdOf(api), {
            url: url.toString(),
            contentType: response.headers.get("content-type") ?? "",
            body,
            sourceName: args.source_name ?? "",
          });
          if (result.added.length === 0) {
            return errorResult("fetch_table", result.text, { kind: "no_tables" });
          }
          return okResult("fetch_table", result.text, summarize("fetch_table", result.text, result.added));
        } catch (error) {
          return errorResult("fetch_table", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    makeAppTool<{ bitable: string; table_id?: string; source_name?: string; max_records?: number }>({
      name: "load_feishu_bitable",
      description:
        "Read a Feishu (Lark) Bitable table through the configured bot and attach it to this conversation as a " +
        "queryable data source. Pass the Bitable link (or its app token) and the table id. Records are bounded; " +
        "the result reports how many were read. Use the normal SQL/analysis tools afterwards.",
      parameters: {
        type: "object",
        properties: {
          bitable: { type: "string", description: "Bitable link (https://…feishu.cn/base/<token>) or its app token." },
          table_id: { type: "string", description: "Table id; may be omitted when the link contains ?table=." },
          source_name: { type: "string", description: "Optional display name for the attached data source." },
          max_records: { type: "integer", minimum: 1, description: "Upper bound on records to read." },
        },
        required: ["bitable"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          if (deps.ingest === undefined) throw new Error("Table ingestion is not available in this build.");
          const { client } = await feishu.connections();
          const read = await readBitableRecords(client, {
            bitable: args.bitable,
            tableId: args.table_id,
            maxRecords: args.max_records,
          });
          const result = await deps.ingest.loadBitable(conversationIdOf(api), read, args.source_name ?? "");
          if (result.added.length === 0) {
            return errorResult("load_feishu_bitable", result.text, { kind: "no_tables" });
          }
          return okResult("load_feishu_bitable", result.text, summarize("load_feishu_bitable", result.text, result.added));
        } catch (error) {
          return errorResult("load_feishu_bitable", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    makeAppTool<{ url?: string }>({
      name: "browser_extract_tables",
      description:
        "Extract tables from a page that only renders with JavaScript. Browser automation is not part of this " +
        "build, so this tool always reports that and points at fetch_table instead. Kept in the registry so a " +
        "model that was told to use it gets a clear answer rather than silence.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page URL, used in the message only." },
        },
        required: [],
      },
      replay: "safe",
      async execute(args) {
        const page = typeof args.url === "string" && args.url !== "" ? ` (${args.url})` : "";
        return errorResult(
          "browser_extract_tables",
          `Browser automation is not available in this build${page}. Call fetch_table with the URL for HTML/CSV/JSON/PDF ` +
            "content, or ask the user to upload the page or file.",
        );
      },
    }),
  ];
}
