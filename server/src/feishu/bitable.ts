/**
 * 飞书多维表格（Bitable）读写。
 *
 * 移植自 `data/feishu_bitable_service.py`：参数校验、错误文案、分批写入与返回值字段逐字沿用。
 * 移植工具与数据源用到的部分（建表、列数据表、读取记录、追加记录、更新单条记录）。
 *
 * 所有请求都带应用身份（tenant_access_token）；不接收也不回显用户 token。
 */

import { say } from "../i18n.ts";
import type { FeishuClient } from "./client.ts";

export class FeishuBitableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuBitableError";
  }
}

/** 多维表格接口的超时（旧实现 `_TIMEOUT = (3.05, 15)`）。 */
const BITABLE_TIMEOUT_MS = 15_000;
const MAX_FIELDS = 200;
const MAX_RECORDS = 100_000;
/** 飞书 batch_create 每次最多 1000 条，按 500 条一批提交。 */
const WRITE_BATCH_SIZE = 500;
const PAGE_SIZE = 100;

export type BitableTable = { table_id: string; name: string; url: string };

/** 旧 `_request`：把飞书的错误码翻译成一句可操作的中文。 */
async function call(
  client: FeishuClient,
  method: "GET" | "POST" | "PUT",
  path: string,
  operation: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  let token: string;
  try {
    token = await client.token();
  } catch (error) {
    throw new FeishuBitableError(error instanceof Error ? error.message : String(error));
  }
  const response = await client.request(method, path, {
    ...options,
    token,
    timeoutMs: BITABLE_TIMEOUT_MS,
  });
  const body = response.body;
  if (response.status < 200 || response.status >= 300 || body === undefined) {
    const code = typeof body?.code === "number" ? body.code : undefined;
    const message = typeof body?.msg === "string" ? body.msg : "";
    const hint = say(
      "Request the “View, comment, edit and manage Bitable” permission in the Feishu Open Platform and publish the app; " +
        "if it still fails, also confirm the app can access the target folder.",
      "请在飞书开放平台申请“查看、评论、编辑和管理多维表格”权限，并发布应用；" +
        "若仍失败，也请确认应用可访问目标文件夹。",
    );
    const suffix = code === undefined ? "" : say(` (error code ${code})`, `（错误码 ${code}）`);
    throw new FeishuBitableError(
      say(
        `Feishu rejected ${operation}${suffix}: ${message === "" ? hint : message}`,
        `飞书拒绝${operation}${suffix}：${message === "" ? hint : message}`,
      ),
    );
  }
  if (typeof body.code === "number" && body.code !== 0) {
    throw new FeishuBitableError(
      say(
        `Feishu rejected ${operation} (error code ${body.code}): ${typeof body.msg === "string" && body.msg !== "" ? body.msg : "check the app permissions and the target folder"}`,
        `飞书拒绝${operation}（错误码 ${body.code}）：${typeof body.msg === "string" && body.msg !== "" ? body.msg : "请检查应用权限与目标文件夹"}`,
      ),
    );
  }
  const data = body.data;
  return asObject(data) ?? {};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `_clean_name`：名称必须是非空文本且不超过长度上限。 */
function cleanName(value: unknown, label: string, maximum = 100): string {
  if (typeof value !== "string") throw new FeishuBitableError(say(`The ${label} must be text`, `${label}必须是文本`));
  const result = value.trim();
  if (result === "") throw new FeishuBitableError(say(`Enter the ${label}`, `请填写${label}`));
  if (result.length > maximum) throw new FeishuBitableError(say(`The ${label} cannot exceed ${maximum} characters`, `${label}不能超过 ${maximum} 个字符`));
  return result;
}

/** `_token`：app_token / table_id / record_id 这类不透明标识的校验。 */
function token(value: unknown, label: string, maximum = 300): string {
  const result = value === undefined || value === null ? "" : String(value).trim();
  if (result === "") throw new FeishuBitableError(say(`Provide the ${label}`, `请提供${label}`));
  if (result.length > maximum || /\s/.test(result)) throw new FeishuBitableError(say(`The ${label} has an invalid format`, `${label}格式不正确`));
  return result;
}

/**
 * 旧 `parse_bitable_reference`：接受多维表格链接或 app_token。
 *
 * 只接受飞书/Lark 域名，且从不请求传入的链接（避免 SSRF）。链接指向应用首页时，
 * table_id 需要单独给出或用链接里的 `?table=…`。
 */
export function parseBitableReference(bitable: unknown, tableId: unknown = ""): {
  appToken: string;
  tableId: string;
} {
  const raw = token(bitable, say("Bitable link or app_token", "多维表格链接或 app_token"));
  let suppliedTable = typeof tableId === "string" ? tableId.trim() : "";
  let appToken = raw;
  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new FeishuBitableError(say("Cannot identify the Bitable app_token from the link", "无法从链接中识别多维表格 app_token"));
    }
    const host = parsed.hostname;
    const allowed =
      host === "feishu.cn" || host.endsWith(".feishu.cn") || host === "larksuite.com" || host.endsWith(".larksuite.com");
    if (!allowed) throw new FeishuBitableError(say("Only Feishu Bitable links are supported", "只支持飞书多维表格链接"));
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    const index = parts.indexOf("base");
    const candidate = index === -1 ? undefined : parts[index + 1];
    if (candidate === undefined) throw new FeishuBitableError(say("Cannot identify the Bitable app_token from the link", "无法从链接中识别多维表格 app_token"));
    appToken = candidate;
    if (suppliedTable === "") suppliedTable = (parsed.searchParams.get("table") ?? "").trim();
  }
  return { appToken: token(appToken, "app_token"), tableId: suppliedTable };
}

/** 旧 `_bitable_url`：带上 `?table=…`，便于模型把可点击链接交付给用户。 */
function bitableUrl(appToken: string, tableId = "", appUrl = ""): string {
  const url = new URL(appUrl === "" ? `https://feishu.cn/base/${appToken}` : appUrl);
  if (tableId !== "") url.searchParams.set("table", tableId);
  return url.toString();
}

/** 旧 `create_bitable` 的前置校验：字段名去重、上限。 */
function normalizeFields(fields: Iterable<unknown>): { field_name: string; type: number }[] {
  const normalized: { field_name: string; type: number }[] = [];
  const seen: Record<string, true> = {};
  for (const raw of fields) {
    const name = cleanName(raw, say("field name", "字段名"), 100);
    if (seen[name] === true) throw new FeishuBitableError(say(`Duplicate field name: ${name}`, `字段名重复：${name}`));
    seen[name] = true;
    normalized.push({ field_name: name, type: 1 });
  }
  if (normalized.length === 0) throw new FeishuBitableError(say("At least one field is required", "至少需要一个字段"));
  if (normalized.length > MAX_FIELDS) throw new FeishuBitableError(say(`At most ${MAX_FIELDS} fields can be created at once`, `一次最多创建 ${MAX_FIELDS} 个字段`));
  return normalized;
}

/**
 * 旧 `_normalize_records`：值必须是已定义的字段；对象/数组按 JSON 文本写入（建表的字段全是文本型）。
 *
 * `str()` 的布尔取值沿用 Python 的 `True`/`False`，避免写进飞书的文本与旧实现不同。
 */
function normalizeRecords(records: Iterable<unknown>, fieldNames: Readonly<Record<string, true>>): { fields: Record<string, string> }[] {
  const normalized: { fields: Record<string, string> }[] = [];
  for (const raw of records) {
    const record = asObject(raw);
    if (record === undefined) throw new FeishuBitableError(say("Each record must be an object of fields and values", "每条记录必须是字段和值组成的对象"));
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const name = key.trim();
      if (name === "" || fieldNames[name] !== true) {
        throw new FeishuBitableError(
          say(
            `Record contains an undefined field: ${name === "" ? "(empty)" : name}`,
            `记录包含未定义字段：${name === "" ? "（空）" : name}`,
          ),
        );
      }
      if (value === null || value === undefined) continue;
      fields[name] = typeof value === "object" ? JSON.stringify(value) : pyStr(value);
    }
    if (Object.keys(fields).length > 0) normalized.push({ fields });
  }
  if (normalized.length > MAX_RECORDS) throw new FeishuBitableError(say(`At most ${MAX_RECORDS} records can be written at once`, `一次最多写入 ${MAX_RECORDS} 条记录`));
  return normalized;
}

function pyStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** 旧 `_write_records`：追加记录时只要求「非空字段对象」，字段是否存在交给飞书判定。 */
function writeRecords(records: Iterable<unknown>): { fields: Record<string, unknown> }[] {
  const normalized: { fields: Record<string, unknown> }[] = [];
  for (const raw of records) {
    const record = asObject(raw);
    if (record === undefined || Object.keys(record).length === 0) {
      throw new FeishuBitableError(say("Each record must be a non-empty object of fields", "每条记录必须是非空字段对象"));
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const name = key.trim();
      if (name !== "") fields[name] = value;
    }
    if (Object.keys(fields).length === 0) throw new FeishuBitableError(say("Each record needs at least one valid field", "每条记录至少需要一个有效字段"));
    normalized.push({ fields });
  }
  if (normalized.length === 0) throw new FeishuBitableError(say("At least one record is required", "至少需要一条记录"));
  if (normalized.length > MAX_RECORDS) throw new FeishuBitableError(say(`At most ${MAX_RECORDS} records can be written at once`, `一次最多写入 ${MAX_RECORDS} 条记录`));
  return normalized;
}

/** 旧 `list_bitable_tables`。 */
export async function listBitableTables(
  client: FeishuClient,
  input: { bitable: unknown },
): Promise<{ app_token: string; tables: BitableTable[] }> {
  const { appToken } = parseBitableReference(input.bitable);
  const tables: BitableTable[] = [];
  let pageToken = "";
  // 旧实现同样按 `_MAX_READ_RECORDS` 设上限；实际分页由飞书的 has_more 决定。
  while (tables.length < MAX_RECORDS) {
    const params: Record<string, string> = { page_size: String(PAGE_SIZE) };
    if (pageToken !== "") params.page_token = pageToken;
    const data = await call(client, "GET", `/bitable/v1/apps/${appToken}/tables`, say("reading Feishu Bitable tables", "读取飞书多维表格数据表"), {
      params,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const table = asObject(item);
      if (table === undefined) continue;
      const tableId = typeof table.table_id === "string" ? table.table_id.trim() : "";
      if (tableId === "") continue;
      tables.push({
        table_id: tableId,
        name: typeof table.name === "string" && table.name !== "" ? table.name : say("Untitled table", "未命名数据表"),
        url: bitableUrl(appToken, tableId),
      });
    }
    if (data.has_more !== true) break;
    const next = typeof data.page_token === "string" ? data.page_token.trim() : "";
    if (next === "") break;
    pageToken = next;
  }
  return { app_token: appToken, tables };
}

/** 旧 `_cell_value`：把多维表格的富文本单元格压成 DataFrame 里可用的标量。 */
function cellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => pyStr(cellValue(item)))
      .join(", ");
  }
  const object = asObject(value);
  if (object !== undefined) {
    for (const key of ["text", "name", "url", "link"]) {
      const scalar = object[key];
      if (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") return scalar;
    }
    // 与旧实现一致：没有可用标量时落成按键排序的 JSON 文本。
    return JSON.stringify(object, (_key, nested: unknown) => {
      const inner = asObject(nested);
      return inner === undefined ? nested : Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  }
  return String(value);
}

export type BitableRead = {
  app_token: string;
  table_id: string;
  url: string;
  records: Record<string, string | number | boolean | null>[];
  record_count: number;
  limited: boolean;
};

/** 旧 `read_bitable_records`：读取有上限的一批记录，保留 record_id 供之后按条编辑。 */
export async function readBitableRecords(
  client: FeishuClient,
  input: { bitable: unknown; tableId?: unknown; maxRecords?: unknown },
): Promise<BitableRead> {
  const { appToken, tableId } = parseBitableReference(input.bitable, input.tableId ?? "");
  if (tableId === "") {
    throw new FeishuBitableError(
      say("Provide a table_id, or use a Bitable link that contains ?table=...", "请提供 table_id，或使用包含 ?table=... 的多维表格链接"),
    );
  }
  const requested = input.maxRecords === undefined ? MAX_RECORDS : Number(input.maxRecords);
  if (!Number.isFinite(requested)) throw new FeishuBitableError(say("max_records must be a number", "max_records 必须是数字"));
  const limit = Math.max(1, Math.min(Math.trunc(requested), MAX_RECORDS));
  const records: BitableRead["records"] = [];
  let pageToken = "";
  let limited = false;
  while (records.length < limit) {
    const params: Record<string, string> = { page_size: String(Math.min(PAGE_SIZE, limit - records.length)) };
    if (pageToken !== "") params.page_token = pageToken;
    const data = await call(client, "GET", `/bitable/v1/apps/${appToken}/tables/${tableId}/records`, say("reading Feishu Bitable records", "读取飞书多维表格记录"), {
      params,
    });
    limited = data.has_more === true;
    for (const item of Array.isArray(data.items) ? data.items : []) {
      const entry = asObject(item);
      if (entry === undefined) continue;
      const row: BitableRead["records"][number] = {};
      for (const [key, value] of Object.entries(asObject(entry.fields) ?? {})) row[key] = cellValue(value);
      const recordId = typeof entry.record_id === "string" ? entry.record_id.trim() : "";
      if (recordId !== "") row._feishu_record_id = recordId;
      records.push(row);
      if (records.length >= limit) break;
    }
    if (records.length >= limit || !limited) break;
    const next = typeof data.page_token === "string" ? data.page_token.trim() : "";
    if (next === "") break;
    pageToken = next;
  }
  return {
    app_token: appToken,
    table_id: tableId,
    url: bitableUrl(appToken, tableId),
    records,
    record_count: records.length,
    limited,
  };
}

/** 旧 `append_bitable_records`。 */
export async function appendBitableRecords(
  client: FeishuClient,
  input: { bitable: unknown; tableId: unknown; records: Iterable<unknown> },
): Promise<{ app_token: string; table_id: string; url: string; record_count: number; record_ids: string[] }> {
  const { appToken, tableId } = parseBitableReference(input.bitable, input.tableId);
  if (tableId === "") throw new FeishuBitableError(say("Provide table_id", "请提供 table_id"));
  const normalized = writeRecords(input.records);
  const recordIds: string[] = [];
  for (let start = 0; start < normalized.length; start += WRITE_BATCH_SIZE) {
    const data = await call(
      client,
      "POST",
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      say("writing Feishu Bitable records", "写入飞书多维表格记录"),
      { body: { records: normalized.slice(start, start + WRITE_BATCH_SIZE) } },
    );
    const created = Array.isArray(data.records) ? data.records : [];
    for (const item of created) {
      const record = asObject(item);
      const recordId = record === undefined ? undefined : record.record_id;
      if (recordId !== undefined && recordId !== null) recordIds.push(String(recordId));
    }
  }
  return {
    app_token: appToken,
    table_id: tableId,
    url: bitableUrl(appToken, tableId),
    record_count: normalized.length,
    record_ids: recordIds,
  };
}

/** 旧 `update_bitable_record`：record_id 必须来自一次读取，绝不猜。 */
export async function updateBitableRecord(
  client: FeishuClient,
  input: { bitable: unknown; tableId: unknown; recordId: unknown; fields: unknown },
): Promise<{
  app_token: string;
  table_id: string;
  record_id: string;
  url: string;
  updated_fields: string[];
}> {
  const { appToken, tableId } = parseBitableReference(input.bitable, input.tableId);
  if (tableId === "") throw new FeishuBitableError(say("Provide table_id", "请提供 table_id"));
  const recordId = token(input.recordId, "record_id");
  const fields = asObject(input.fields);
  if (fields === undefined || Object.keys(fields).length === 0) {
    throw new FeishuBitableError(say("fields must be a non-empty object of fields", "fields 必须是非空字段对象"));
  }
  const cleanFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const name = key.trim();
    if (name !== "") cleanFields[name] = value;
  }
  if (Object.keys(cleanFields).length === 0) throw new FeishuBitableError(say("fields needs at least one valid field", "fields 至少需要一个有效字段"));
  await call(
    client,
    "PUT",
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    say("updating a Feishu Bitable record", "更新飞书多维表格记录"),
    { body: { fields: cleanFields } },
  );
  return {
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
    url: bitableUrl(appToken, tableId),
    updated_fields: Object.keys(cleanFields).sort(),
  };
}

/** 旧 `create_bitable`：建一个 Base 应用、一张文本字段数据表，可选写入首批记录。 */
export async function createBitable(
  client: FeishuClient,
  input: {
    name: unknown;
    tableName: unknown;
    fields: Iterable<unknown>;
    records?: Iterable<unknown>;
    folderToken?: unknown;
  },
): Promise<{
  app_token: string;
  table_id: string;
  name: string;
  table_name: string;
  record_count: number;
  url: string;
}> {
  const baseName = cleanName(input.name, say("Bitable name", "多维表格名称"));
  const tableName = cleanName(input.tableName, say("table name", "数据表名称"));
  const normalizedFields = normalizeFields(input.fields);
  const fieldNames: Record<string, true> = {};
  for (const field of normalizedFields) fieldNames[field.field_name] = true;
  const normalizedRecords = normalizeRecords(input.records ?? [], fieldNames);
  const folder = typeof input.folderToken === "string" ? input.folderToken.trim() : "";
  const targetFolder = folder !== "" ? folder : await rootFolderToken(client);
  const appData = await call(client, "POST", "/bitable/v1/apps", say("creating a Feishu Bitable", "创建飞书多维表格"), {
    body: { name: baseName, folder_token: targetFolder },
  });
  const app = asObject(appData.app) ?? {};
  const appToken = typeof app.app_token === "string" ? app.app_token.trim() : "";
  if (appToken === "") {
    throw new FeishuBitableError(say("Feishu reported success but did not return the Bitable identifier; check Drive later", "飞书已返回成功但未提供多维表格标识，请稍后在云空间确认"));
  }
  const tableData = await call(client, "POST", `/bitable/v1/apps/${appToken}/tables`, say("creating a Feishu table", "创建飞书数据表"), {
    body: { table: { name: tableName, fields: normalizedFields } },
  });
  // 当前 REST API 返回 `data.table_id`；部分 SDK 版本序列化成 `data.table.table_id`。
  const table = asObject(tableData.table) ?? {};
  const tableId =
    (typeof tableData.table_id === "string" && tableData.table_id.trim() !== ""
      ? tableData.table_id.trim()
      : typeof table.table_id === "string"
        ? table.table_id.trim()
        : "") || "";
  if (tableId === "") {
    throw new FeishuBitableError(say("The Bitable was created but no table identifier was returned; check the table structure in Feishu", "多维表格已创建，但未返回数据表标识；请在飞书中检查表结构"));
  }
  for (let start = 0; start < normalizedRecords.length; start += WRITE_BATCH_SIZE) {
    await call(
      client,
      "POST",
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      say("writing Feishu Bitable records", "写入飞书多维表格记录"),
      { body: { records: normalizedRecords.slice(start, start + WRITE_BATCH_SIZE) } },
    );
  }
  return {
    app_token: appToken,
    table_id: tableId,
    name: baseName,
    table_name: tableName,
    record_count: normalizedRecords.length,
    url: bitableUrl(appToken, tableId, typeof app.url === "string" ? app.url : ""),
  };
}

/** 旧 `_root_folder_token`：Drive Explorer v2 的根文件夹元数据。 */
async function rootFolderToken(client: FeishuClient): Promise<string> {
  const data = await call(client, "GET", "/drive/explorer/v2/root_folder/meta", say("reading the Feishu default save folder", "读取飞书默认保存文件夹"));
  const token = typeof data.token === "string" ? data.token.trim() : "";
  if (token === "") {
    throw new FeishuBitableError(
      say("Cannot read the Feishu root folder. Request Drive read permission, or provide a writable folder token in the create request.", "无法读取飞书根文件夹。请申请云空间读取权限，或在创建请求中提供可写文件夹 Token。"),
    );
  }
  return token;
}
