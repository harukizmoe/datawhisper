/**
 * 知识库的界面侧 API：所有读写都转发给 Python compute 的 `knowledge.*` 方法，
 * Bun 不另建一套指标/规则/笔记存储（否则两边会分叉）。
 *
 * 错误翻译：compute 的 `-32602` 一律视为参数不合法；`data.kind` 为 not_found 一类的
 * 业务码翻译成 `not_found`，其余保留在 `data.computeKind`，界面仍能按细分码展示。
 * 删除类的方法在这里做成幂等：重复删除返回 `deleted: false`，而不是抛错。
 */
import type { ComputeClient } from "../compute/client.ts";
import { invalidParams } from "../ipc/errors.ts";
import { isComputeMissing, translateComputeError } from "./compute-errors.ts";

export type KnowledgeKind = "category" | "metric" | "rule" | "note";
const KINDS: Readonly<Record<KnowledgeKind, true>> = { category: true, metric: true, rule: true, note: true };

export function knowledgeKind(value: unknown): KnowledgeKind {
  if (typeof value !== "string" || !Object.hasOwn(KINDS, value)) {
    throw invalidParams("'kind' must be one of: category, metric, rule, note");
  }
  return value as KnowledgeKind;
}

/** 界面可以用 camelCase 提交；Python 记录字段仍是 snake_case，在这里统一。 */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  ruleId: "rule_id",
  sqlTemplate: "sql_template",
  categoryId: "category_id",
};

export function normalizeKnowledgeRecord(
  record: Record<string, unknown>,
  categoryId?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const field = Object.hasOwn(FIELD_ALIASES, key) ? FIELD_ALIASES[key]! : key;
    out[field] = field === "enabled" && typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  if (categoryId !== undefined) out.category_id = categoryId;
  return out;
}

export type KnowledgeLibraryDeps = {
  compute: Pick<ComputeClient, "call">;
};

export class KnowledgeLibrary {
  readonly #compute: Pick<ComputeClient, "call">;

  constructor(deps: KnowledgeLibraryDeps) {
    this.#compute = deps.compute;
  }

  async #call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.#compute.call<T>(method, params);
    } catch (error) {
      translateComputeError(error);
    }
  }

  /** 不给 kind 时按类型聚合；分类永远一起返回，界面用它渲染侧栏。 */
  async list(params: { kind?: unknown; categoryId?: number }) {
    if (params.kind !== undefined) {
      const kind = knowledgeKind(params.kind);
      const request: Record<string, unknown> = { kind };
      if (params.categoryId !== undefined) request.category_id = params.categoryId;
      return this.#call("knowledge.list", request);
    }
    const base = params.categoryId === undefined ? {} : { category_id: params.categoryId };
    const [categories, metrics, rules, notes] = await Promise.all([
      this.#call<{ items: unknown[] }>("knowledge.list", { kind: "category" }),
      this.#call<{ items: unknown[] }>("knowledge.list", { kind: "metric", ...base }),
      this.#call<{ items: unknown[] }>("knowledge.list", { kind: "rule", ...base }),
      this.#call<{ items: unknown[] }>("knowledge.list", { kind: "note", ...base }),
    ]);
    return {
      categoryId: params.categoryId ?? 1,
      categories: categories.items,
      metrics: metrics.items,
      rules: rules.items,
      notes: notes.items,
    };
  }

  add(params: { kind: unknown; record: Record<string, unknown>; categoryId?: number }) {
    return this.#call("knowledge.add", {
      kind: knowledgeKind(params.kind),
      record: normalizeKnowledgeRecord(params.record, params.categoryId),
    });
  }

  update(params: { kind: unknown; id: number; fields: Record<string, unknown>; categoryId?: number }) {
    return this.#call("knowledge.update", {
      kind: knowledgeKind(params.kind),
      id: params.id,
      fields: normalizeKnowledgeRecord(params.fields, params.categoryId),
    });
  }

  async remove(params: { kind: unknown; id: number }) {
    const kind = knowledgeKind(params.kind);
    try {
      return await this.#compute.call("knowledge.delete", { kind, id: params.id });
    } catch (error) {
      if (isComputeMissing(error)) return { deleted: false };
      translateComputeError(error);
    }
  }

  toggle(params: { kind: unknown; id: number }) {
    return this.#call("knowledge.toggle", { kind: knowledgeKind(params.kind), id: params.id });
  }

  search(params: { query: string }) {
    return this.#call("knowledge.search", { q: params.query });
  }

  parse(params: { filePath: string; name?: string }) {
    const request: Record<string, unknown> = { file_path: params.filePath };
    if (params.name !== undefined) request.name = params.name;
    return this.#call("knowledge.parse", request);
  }

  files() {
    return this.#call("knowledge.files");
  }

  extract(params: { replies: string[] }) {
    return this.#call("knowledge.extract", { replies: params.replies });
  }

  confirm(params: { records?: Record<string, unknown>[]; filename?: string; categoryId?: number }) {
    const request: Record<string, unknown> = {};
    if (params.records !== undefined) request.records = params.records;
    if (params.filename !== undefined) request.filename = params.filename;
    if (params.categoryId !== undefined) request.category_id = params.categoryId;
    return this.#call("knowledge.confirm", request);
  }

  async deleteFile(params: { filename: string }) {
    try {
      return await this.#compute.call("knowledge.deleteFile", { filename: params.filename });
    } catch (error) {
      if (isComputeMissing(error)) return { deleted: false, chunks: 0 };
      translateComputeError(error);
    }
  }

  rebuildEmbeddings() {
    return this.#call("knowledge.rebuildEmbeddings");
  }

  // ── 分类是 knowledge.category 的薄包装，界面按分类操作时不用记 kind ─────────────

  async categories() {
    const { items } = await this.#call<{ items: unknown[] }>("knowledge.list", { kind: "category" });
    return { categories: items };
  }

  addCategory(params: { name: string }) {
    return this.#call("knowledge.add", { kind: "category", record: { name: params.name } });
  }

  updateCategory(params: { id: number; name?: string; enabled?: boolean | number }) {
    const fields: Record<string, unknown> = {};
    if (params.name !== undefined) fields.name = params.name;
    if (params.enabled !== undefined) fields.enabled = typeof params.enabled === "boolean" ? (params.enabled ? 1 : 0) : params.enabled;
    return this.#call("knowledge.update", { kind: "category", id: params.id, fields });
  }

  toggleCategory(params: { id: number }) {
    return this.#call("knowledge.toggle", { kind: "category", id: params.id });
  }

  removeCategory(params: { id: number }) {
    return this.remove({ kind: "category", id: params.id });
  }
}
