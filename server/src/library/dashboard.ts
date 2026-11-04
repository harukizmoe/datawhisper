/**
 * 仪表盘的 Bun 侧存储与 RPC 转发。
 *
 * 路径与旧 `api/dashboard.py` / `compute/dashboard.py` 一致：
 * `<dataRoot>/outputs/Dashboard/<清洗后的 id>.json`。`dataRoot` 必须是 compute worker 的
 * `BAA_DATA_DIR`（集成时由 `service.ts` 传入），否则 Bun 写的文件 Python 读不到。
 *
 * `refresh` 与 `exportHtml` 仍由 compute 执行（它持有 source registry、chart store 与渲染器）；
 * 这里只做参数翻译，并在导出结果上做一次自包含清洗：去掉外链脚本/样式/图片，插入 CSP，
 * 保证导出的 HTML 离线打开时不会发起外网请求。
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ComputeClient } from "../compute/client.ts";
import { appError, invalidParams } from "../ipc/errors.ts";
import { isoNow, readJson, writeJson } from "./files.ts";
import { translateComputeError } from "./compute-errors.ts";

const SCHEMA_VERSION = 2;

export type DashboardLibraryDeps = {
  compute: Pick<ComputeClient, "call">;
  /** `<dataRoot>/outputs/Dashboard`。 */
  dashboardDir: string;
  /** `<dataRoot>/outputs/charts`：`dashboard.exportHtml` 读取 `<chart_id>.html` 的位置。 */
  chartDir: string;
};

type Dashboard = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  widgets?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

function safeId(id: string): string {
  const safe = id.trim().replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (safe === "") throw invalidParams("'id' must contain at least one letter, digit, underscore, or hyphen");
  return safe;
}

function pathFor(directory: string, id: string): string {
  return join(directory, `${safeId(id)}.json`);
}

function widgetsOf(dashboard: Dashboard): Record<string, unknown>[] {
  return Array.isArray(dashboard.widgets)
    ? dashboard.widgets.filter((widget): widget is Record<string, unknown> => typeof widget === "object" && widget !== null && !Array.isArray(widget))
    : [];
}

/** 外链脚本/样式/图片与 `@import` 全部去掉；注入 CSP 后页面不再能发起网络请求。 */
export function makeSelfContained(html: string): string {
  let out = html;
  out = out.replace(
    /<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|&quot;[^&]*&quot;|[^\s>]+)[^>]*>\s*<\/script\s*>/gi,
    "",
  );
  out = out.replace(/<script\b[^>]*\bsrc\s*=[^>]*>/gi, "");
  out = out.replace(/<link\b[^>]*>/gi, "");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/@import\s+(?:url\()?[^;]+;/gi, "");
  out = out.replace(/url\(\s*["']?(?:https?:)?\/\/[^)]*\)/gi, "url()");
  out = out.replace(
    /\s(?:src|href|srcset|poster|data-src|data|action|formaction)\s*=\s*(?:"[^"]*(?:https?:)?\/\/[^"]*"|'[^']*(?:https?:)?\/\/[^']*'|&quot;[^&]*(?:https?:)?\/\/[^&]*&quot;)/gi,
    "",
  );
  const csp =
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; img-src data:; media-src data:; font-src data:; ` +
    `style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head([^>]*)>/i, `<head$1>${csp}`) : `${csp}${out}`;
  return out;
}

export class DashboardLibrary {
  readonly #deps: DashboardLibraryDeps;

  constructor(deps: DashboardLibraryDeps) {
    this.#deps = deps;
  }

  list() {
    const directory = this.#deps.dashboardDir;
    if (!existsSync(directory)) return { dashboards: [] };
    const dashboards: Record<string, unknown>[] = [];
    const names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    for (const name of names) {
      const stem = name.slice(0, -".json".length);
      let raw: unknown;
      try {
        raw = readJson(join(directory, name));
      } catch {
        // 单个坏文件不应让整个仪表盘列表不可用（旧实现同样跳过并记日志）。
        continue;
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const dashboard = raw as Dashboard;
      dashboards.push({
        id: typeof dashboard.id === "string" && dashboard.id !== "" ? dashboard.id : stem,
        name: typeof dashboard.name === "string" && dashboard.name !== "" ? dashboard.name : stem,
        created_at: typeof dashboard.created_at === "string" ? dashboard.created_at : "",
        updated_at: typeof dashboard.updated_at === "string" ? dashboard.updated_at : "",
        widget_count: widgetsOf(dashboard).length,
      });
    }
    return { dashboards };
  }

  create(params: Record<string, unknown>) {
    const requested = typeof params.id === "string" && params.id.trim() !== "" ? params.id : crypto.randomUUID().replaceAll("-", "");
    const id = safeId(requested);
    const path = pathFor(this.#deps.dashboardDir, id);
    if (existsSync(path)) throw invalidParams(`dashboard already exists: ${id}`);
    if (params.widgets !== undefined && !Array.isArray(params.widgets)) throw invalidParams("'widgets' must be a list");
    const now = isoNow();
    const colorScheme = params.colorScheme ?? params.color_scheme;
    const workspaceId = params.workspaceId ?? params.workspace_id;
    const sessionId = params.sessionId ?? params.session_id;
    const containerWidth = params.containerWidth ?? params.container_width;
    const dashboard: Record<string, unknown> = {
      schema_version: SCHEMA_VERSION,
      id,
      name: typeof params.name === "string" && params.name.trim() !== "" ? params.name.trim() : "Dashboard",
      created_at: now,
      updated_at: now,
      color_scheme: typeof colorScheme === "string" && colorScheme !== "" ? colorScheme : "mckinsey",
      workspace_id: typeof workspaceId === "string" ? workspaceId : "",
      session_id: typeof sessionId === "string" ? sessionId : "",
      widgets: params.widgets ?? [],
    };
    if (containerWidth !== undefined) dashboard.container_width = containerWidth;
    writeJson(path, dashboard);
    return dashboard;
  }

  get(id: string): Dashboard {
    const raw = readJson(pathFor(this.#deps.dashboardDir, id));
    if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw appError("not_found", `Dashboard '${id}' not found`);
    }
    return raw as Dashboard;
  }

  update(params: Record<string, unknown>) {
    const id = typeof params.id === "string" ? params.id : "";
    if (id === "") throw invalidParams("'id' must be a non-empty string");
    const dashboard = this.get(id);
    if (params.name !== undefined) {
      if (typeof params.name !== "string") throw invalidParams("'name' must be a string");
      dashboard.name = params.name;
    }
    if (params.containerWidth !== undefined || params.container_width !== undefined) {
      dashboard.container_width = params.containerWidth ?? params.container_width;
    }
    if (params.colorScheme !== undefined || params.color_scheme !== undefined) {
      dashboard.color_scheme = params.colorScheme ?? params.color_scheme;
    }
    if (params.replaceWidgets === true) {
      if (!Array.isArray(params.widgets)) throw invalidParams("'widgets' must be a list");
      dashboard.widgets = params.widgets;
    } else if (Array.isArray(params.widgets)) {
      // 旧 PUT 只接受每个 widget 的 grid；保留这个语义，布局拖拽不会覆盖 SQL 等其它字段。
      const updates = new Map<string, unknown>();
      for (const widget of params.widgets) {
        if (typeof widget !== "object" || widget === null || Array.isArray(widget)) continue;
        const entry = widget as Record<string, unknown>;
        if (typeof entry.id === "string" && entry.grid !== undefined) updates.set(entry.id, entry.grid);
      }
      if (updates.size > 0) {
        dashboard.widgets = widgetsOf(dashboard).map((widget) => {
          const next = updates.get(String(widget.id ?? ""));
          return next === undefined ? widget : { ...widget, grid: next };
        });
      }
    }
    dashboard.updated_at = isoNow();
    writeJson(pathFor(this.#deps.dashboardDir, id), dashboard);
    return { ok: true, dashboard };
  }

  remove(id: string) {
    const path = pathFor(this.#deps.dashboardDir, id);
    if (!existsSync(path)) return { deleted: false };
    unlinkSync(path);
    return { deleted: true };
  }

  async refresh(params: {
    id: string;
    sourceId: string;
    workspaceId?: string;
    widgetId?: string;
  }) {
    this.get(params.id);
    const request: Record<string, unknown> = { dashboard_id: params.id, source_id: params.sourceId };
    if (params.workspaceId !== undefined) request.workspace_id = params.workspaceId;
    if (params.widgetId !== undefined) request.widget_id = params.widgetId;
    try {
      return await this.#deps.compute.call("dashboard.refresh", request);
    } catch (error) {
      translateComputeError(error);
    }
  }

  async exportHtml(id: string) {
    const dashboard = this.get(id);
    let result: { filename?: string; html?: string };
    try {
      result = await this.#deps.compute.call<{ filename: string; html: string }>("dashboard.exportHtml", {
        dashboard_id: id,
        chart_dir: this.#deps.chartDir,
      });
    } catch (error) {
      translateComputeError(error);
    }
    const name = typeof dashboard.name === "string" && dashboard.name !== "" ? dashboard.name : "dashboard";
    const filename =
      typeof result.filename === "string" && result.filename !== ""
        ? result.filename
        : `${name.replace(/[^\p{L}\p{N}_-]/gu, "_")}.html`;
    const html = typeof result.html === "string" ? result.html : "";
    return { filename, html: makeSelfContained(html) };
  }
}
