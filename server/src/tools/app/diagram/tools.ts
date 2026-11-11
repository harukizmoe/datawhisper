/**
 * 3 个 draw.io 工具：display_diagram / edit_diagram / get_diagram。
 *
 * schema 与返回结构逐字移植自 `agent/tools/schemas.py` 与
 * `agent/tools/business/diagram.py`。旧实现把 `<mxfile>` XML 存进画布项目，
 * 前端通过 `canvas_event` 刷新；工具结果里仍带 `xml` 与 `project`。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { makeAppTool, type AppTool, type AppToolDetails, type AppToolDeps } from "../types.ts";
import { DIAGRAM_TEMPLATES } from "./templates.ts";
import { applyDiagramTheme, qcDiagram } from "./theme.ts";
import {
  applyDiagramOperations,
  isMxcellXmlComplete,
  validateAndFixXml,
  wrapWithMxfile,
  type XmlOperation,
} from "./xml.ts";

const SHAPE_LIBRARY_REF_RE = /\bmxgraph\.([a-z0-9_-]+)(?:\.|;)/gi;

type Success = {
  output: { type: "text"; text: string }[];
  details: AppToolDetails;
};

type Failure = {
  isError: true;
  output: { type: "text"; text: string }[];
  details: AppToolDetails;
};

function loadShapeLibraryReference(library: string, dir: string | undefined): Record<string, JsonValue> {
  const normalized = library.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9_-]+$/.test(normalized)) {
    return { ok: false, error: "Invalid shape library name" };
  }
  if (dir === undefined) {
    return { ok: false, library: normalized, error: `Shape library '${normalized}' is not installed`, available: [] };
  }
  try {
    return {
      ok: true,
      library: normalized,
      content: readFileSync(join(dir, `${normalized}.md`), "utf8"),
    };
  } catch {
    let available: string[] = [];
    try {
      available = readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
    } catch {
      available = [];
    }
    return {
      ok: false,
      library: normalized,
      error: `Shape library '${normalized}' is not installed`,
      available,
    };
  }
}

function inspectShapeLibraries(xml: string, dir: string | undefined): {
  ok: boolean;
  libraries: JsonValue[];
  missing: JsonValue[];
} {
  const libraries = [...new Set([...xml.matchAll(SHAPE_LIBRARY_REF_RE)].map((match) => match[1] as string))].sort();
  const resolved = libraries.map((library) => loadShapeLibraryReference(library, dir));
  return {
    ok: resolved.every((item) => item.ok === true),
    libraries,
    missing: resolved.filter((item) => item.ok !== true),
  };
}

function escapeAttribute(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;");
}

/** 等价于 ElementTree 设置 value 属性：已有则替换，没有则插入。 */
function setCellValue(xml: string, cellId: string, text: string): string | undefined {
  const pattern = new RegExp(`<mxCell\\b[^>]*?\\bid\\s*=\\s*["']${cellId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*?>`);
  const match = pattern.exec(xml);
  if (match === null) return undefined;
  const tag = match[0];
  const escaped = escapeAttribute(text);
  let replacement: string;
  if (/\bvalue\s*=\s*"/.test(tag)) {
    replacement = tag.replace(/\bvalue\s*=\s*"[^"]*"/, `value="${escaped}"`);
  } else if (tag.endsWith("/>")) {
    replacement = tag.replace(/\/>$/, ` value="${escaped}"/>`);
  } else {
    replacement = tag.replace(/>$/, ` value="${escaped}">`);
  }
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + tag.length);
}

function fillTemplateContent(templateId: string, content: Record<string, string>): string {
  const template = DIAGRAM_TEMPLATES[templateId];
  if (template === undefined) throw new Error(`Unknown template_id: ${templateId}`);
  let xml = template.xml;
  let applied = 0;
  for (const [key, text] of Object.entries(content)) {
    const cellId = template.content_cells[key];
    if (cellId === undefined) continue;
    const updated = setCellValue(xml, cellId, text);
    if (updated !== undefined) {
      xml = updated;
      applied += 1;
    }
  }
  if (applied === 0 && Object.keys(content).length > 0) {
    const known = Object.keys(template.content_cells).sort();
    throw new Error(`No content cells matched for template ${templateId}; known keys: ${JSON.stringify(known)}`);
  }
  return xml;
}

function text(value: unknown): string {
  return JSON.stringify(value);
}

export function createDiagramTools(deps: AppToolDeps): AppTool[] {
  const store = deps.canvas;
  const missing = (tool: string): Failure => ({
    isError: true,
    output: [{ type: "text", text: "Canvas storage is not available." }],
    details: { tool, error: { kind: "tool_error", message: "Canvas storage is not available." } },
  });

  function failure(tool: string, result: Record<string, JsonValue>): Failure {
    return {
      isError: true,
      output: [{ type: "text", text: text(result) }],
      details: { tool, ...result },
    };
  }

  function success(tool: string, result: Record<string, JsonValue>): Success {
    return {
      output: [{ type: "text", text: text(result) }],
      details: { tool, ...result },
    };
  }

  return [
    makeAppTool<{
      xml?: string;
      title?: string;
      template_id?: string;
      content?: Record<string, string>;
      project_id?: string;
    }>({
      name: "display_diagram",
      description:
        "Display a draw.io diagram in the business canvas drawer. " +
        "PREFERRED: use content-fill mode (template_id + content) for known frameworks " +
        "to guarantee correct layout. Only use raw xml for custom diagrams. " +
        "Shape-library references in raw XML are resolved and validated internally. " +
        "Available templates: business_model_canvas, bcg_matrix, swot_analysis, value_proposition.",
      parameters: {
        type: "object",
        properties: {
          xml: {
            type: "string",
            description: "Complete draw.io XML for custom diagrams. OMIT this when using content-fill mode.",
          },
          title: { type: "string", description: "Diagram title shown in the drawer header." },
          template_id: {
            type: "string",
            description: "Template id for content-fill mode. Use this WITH content parameter instead of xml for known frameworks.",
            enum: ["business_model_canvas", "bcg_matrix", "swot_analysis", "value_proposition"],
          },
          content: {
            type: "object",
            description:
              "Content-fill mode: JSON object mapping section keys to text strings. Requires template_id. BMC keys: key_partners, key_activities, key_resources, value_proposition, customer_relationships, channels, customer_segments, cost_structure, revenue_streams. BCG keys: stars, question_marks, cash_cows, dogs. SWOT keys: strengths, weaknesses, opportunities, threats. VP keys: product_service, customer_segments, customer_jobs, pain_relievers, gain_creators, competitors.",
            additionalProperties: { type: "string" },
          },
          project_id: {
            type: "string",
            description: "Optional existing canvas project id to update. If omitted, a new project is created.",
          },
        },
        required: [],
      },
      replay: "unsafe",
      async execute(args) {
        if (store === undefined) return missing("display_diagram");
        let xml = args.xml ?? "";
        const title = args.title || "Diagram";
        let templateId = args.template_id ?? "";
        const projectId = args.project_id ?? "";
        const content = args.content;
        if (content && Object.keys(content).length > 0 && templateId) {
          try {
            xml = fillTemplateContent(templateId, content);
          } catch (error) {
            return failure("display_diagram", { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        } else if (content && Object.keys(content).length > 0 && !templateId) {
          return failure("display_diagram", { ok: false, error: "template_id is required when using content mode" });
        }
        if (!xml) {
          return failure("display_diagram", { ok: false, error: "either xml or (template_id + content) is required" });
        }
        const shapeLibraries = inspectShapeLibraries(xml, deps.shapeLibsDir);
        if (!shapeLibraries.ok) {
          const missingLibraries = shapeLibraries.missing.map((item) => String((item as Record<string, JsonValue>).library)).join(", ");
          return failure("display_diagram", {
            ok: false,
            error: `Diagram XML references unavailable shape libraries: ${missingLibraries}`,
            shape_libraries: shapeLibraries as unknown as JsonValue,
          });
        }
        if (!xml.includes("<mxfile>")) xml = wrapWithMxfile(xml);
        const validation = validateAndFixXml(xml);
        if (!validation.valid) {
          return failure("display_diagram", {
            ok: false,
            error: `Invalid diagram XML: ${validation.error ?? ""}`,
            fixes_applied: validation.fixes,
          });
        }
        xml = validation.fixed ?? xml;
        if (!isMxcellXmlComplete(xml)) {
          return failure("display_diagram", {
            ok: false,
            error: "Diagram XML appears truncated. Please provide complete XML.",
            truncated: true,
          });
        }
        const theme = applyDiagramTheme(xml, deps.colorScheme?.value ?? "mckinsey");
        xml = theme.xml;
        const warnings = qcDiagram(xml);
        try {
          let project;
          if (projectId) {
            const existing = await store.getProject(projectId, deps.sessionId);
            if (existing === undefined) {
              return failure("display_diagram", { ok: false, error: `Canvas project ${projectId} not found` });
            }
            project = await store.updateProjectDiagramXml({ projectId, diagramXml: xml, actorType: "agent" });
            project = await store.updateProjectRenderingMode({ projectId, renderingMode: "diagram" });
          } else {
            if (!templateId) templateId = "business_model_canvas";
            const created = await store.createProject({ sessionId: deps.sessionId, templateId, title });
            project = await store.updateProjectDiagramXml({
              projectId: created.id,
              diagramXml: xml,
              actorType: "agent",
            });
            project = await store.updateProjectRenderingMode({ projectId: created.id, renderingMode: "diagram" });
          }
          return success("display_diagram", {
            ok: true,
            project: project as unknown as JsonValue,
            xml,
            fixes_applied: validation.fixes,
            shape_libraries: shapeLibraries.libraries,
            warnings,
          });
        } catch (error) {
          return failure("display_diagram", {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    makeAppTool<{ project_id: string; operations: XmlOperation[] }>({
      name: "edit_diagram",
      description:
        "Edit specific cells in the current diagram by ID-based operations (update/add/delete). " +
        "ALWAYS call get_diagram first to see current cell IDs before editing.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "The canvas project id to edit." },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["update", "add", "delete"], description: "The operation type." },
                cell_id: { type: "string", description: "The mxCell id to target." },
                new_xml: {
                  type: "string",
                  description: "For update/add: the new mxCell XML fragment. Must contain an mxCell element with the same id as cell_id.",
                },
              },
              required: ["operation", "cell_id"],
            },
            description: "Array of operations to apply to the diagram.",
          },
        },
        required: ["project_id", "operations"],
      },
      replay: "unsafe",
      async execute(args) {
        if (store === undefined) return missing("edit_diagram");
        const projectId = args.project_id ?? "";
        const operations = args.operations ?? [];
        if (!projectId) return failure("edit_diagram", { ok: false, error: "project_id is required" });
        if (operations.length === 0) return failure("edit_diagram", { ok: false, error: "operations array is required" });
        const currentXml = await store.getProjectDiagramXml(projectId);
        if (!currentXml) {
          return failure("edit_diagram", { ok: false, error: `No diagram XML found for project ${projectId}` });
        }
        const applied = applyDiagramOperations(currentXml, operations);
        let newXml = applied.result;
        const errors = applied.errors;
        if (errors.length > 0 && !newXml) {
          return failure("edit_diagram", {
            ok: false,
            error: "All operations failed",
            operation_errors: errors as unknown as JsonValue,
          });
        }
        const validation = validateAndFixXml(newXml);
        if (!validation.valid) {
          return failure("edit_diagram", {
            ok: false,
            error: `Result XML invalid after operations: ${validation.error ?? ""}`,
          });
        }
        newXml = validation.fixed ?? newXml;
        const shapeLibraries = inspectShapeLibraries(newXml, deps.shapeLibsDir);
        if (!shapeLibraries.ok) {
          const missingLibraries = shapeLibraries.missing.map((item) => String((item as Record<string, JsonValue>).library)).join(", ");
          return failure("edit_diagram", {
            ok: false,
            error: `Result XML references unavailable shape libraries: ${missingLibraries}`,
            shape_libraries: shapeLibraries as unknown as JsonValue,
          });
        }
        const theme = applyDiagramTheme(newXml, deps.colorScheme?.value ?? "mckinsey");
        newXml = theme.xml;
        const warnings = qcDiagram(newXml);
        try {
          const project = await store.updateProjectDiagramXml({
            projectId,
            diagramXml: newXml,
            actorType: "agent",
          });
          return success("edit_diagram", {
            ok: true,
            project: project as unknown as JsonValue,
            xml: newXml,
            operation_errors: errors as unknown as JsonValue,
            fixes_applied: validation.fixes,
            shape_libraries: shapeLibraries.libraries,
            warnings,
          });
        } catch (error) {
          return failure("edit_diagram", {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    makeAppTool<{ project_id: string }>({
      name: "get_diagram",
      description: "Get the current diagram XML from a canvas project. Use this before edit_diagram to see current cell IDs.",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string", description: "The canvas project id." } },
        required: ["project_id"],
      },
      replay: "safe",
      async execute(args) {
        if (store === undefined) return missing("get_diagram");
        const projectId = args.project_id ?? "";
        if (!projectId) return failure("get_diagram", { ok: false, error: "project_id is required" });
        const project = await store.getProject(projectId, deps.sessionId);
        if (project === undefined) {
          return failure("get_diagram", { ok: false, error: `Canvas project ${projectId} not found` });
        }
        const xml = typeof project.diagram_xml === "string" ? project.diagram_xml : "";
        return success("get_diagram", {
          ok: true,
          project_id: projectId,
          xml,
          template_id: typeof project.template_id === "string" ? project.template_id : "",
        });
      },
    }),
  ];
}
