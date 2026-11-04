/**
 * 9 个工作区工具：workspace_status/glob/grep/read/write/edit/delete/move/bash。
 *
 * schema 文案逐字来自 `agent/tools/schemas.py::WORKSPACE_TOOL_SCHEMAS`；
 * 错误就是 `WorkspaceFs` 抛出的旧文案，工具层不再改写。
 */

import type { JsonValue } from "@earendil-works/chord";
import { AppToolError, errorResult, makeAppTool, okResult, renderValue, type AppTool, type AppToolDeps } from "../types.ts";

const WORKSPACE_DESCRIPTIONS = {
  status:
    "Return a bounded metadata summary for the always-available system " +
    "Workspace roots uploads, outputs and mcp, plus the optional mounted " +
    "user workspace. The summary contains counts and at most five recent " +
    "files per root; it never reads file contents. System-root files are " +
    "metadata only: page with workspace_glob and inspect only relevant " +
    "files. Structured files in a mounted user workspace are already registered as " +
    "data-source tables and should be queried through get_schema/query_data; " +
    "common documents such as .txt/.doc/.docx can be read with workspace_read_file." +
    "\n\nCall this FIRST whenever the user mentions local files, a project " +
    "folder, or asks you to read/analyse files they have on disk. " +
    "NEVER reply 'I cannot browse' or 'please upload' without calling this tool. " +
    "The system roots remain available even when no user folder is mounted.",
  glob:
    "Page through file metadata recursively. When a user workspace is mounted, omit path to search that mounted directory first; pattern '*' or '**/*' lists files under subfolders too. Returned user/... paths can be passed unchanged to read, move, or delete tools. Use explicit workspace://uploads, workspace://outputs, or workspace://mcp only for system roots. Contents are never read by this tool.",
  grep:
    "Regex-search allowlisted UTF-8 text files on demand. At most 50 matches and 200 candidate files are examined; dependency, cache and build directories are skipped.",
  read:
    "Read one allowlisted text, DOC/DOCX, or spreadsheet file from the mounted/system workspace. The file_path must be an exact path from workspace_glob/workspace_status or the conversation; never guess names like readme.txt or 字段说明.md when the user asks for a vague 说明文档. Text files support common encodings such as UTF-8, UTF-16 and GB18030; legacy .doc uses best-effort text extraction. Excel/XLS/XLSX/ODS files return a bounded worksheet preview (up to 256 MiB file size); use sheet_name, offset, and next_offset to page through rows. Text/DOC/DOCX files allow up to 20 MiB. Output remains capped at 400 lines and 12000 characters. Existing files must be read before write/edit.",
  write:
    "Write UTF-8 content up to 20 MiB to workspace://outputs or an explicitly mounted user workspace. Existing files must be read first; uploads, mcp and sensitive/internal paths are read-only.",
  edit:
    "Replace one unique exact string in a previously-read file under outputs or the mounted user workspace. System uploads and mcp roots are read-only.",
  delete:
    "Delete exactly one file from workspace://outputs or a writable mounted user workspace. Recursive/directory deletion is forbidden and confirm=true is always required.",
  move:
    "Move or rename exactly one file within writable workspace roots. Directory moves are forbidden; replacing an existing file requires confirm_overwrite=true.",
  bash:
    "Run the strongest restricted command facade in the mounted workspace. Allowed commands: pwd, ls/dir, cat, rg, sha256sum/shasum, json_validate/json validate, read-only git status/log/diff, python -m compileall, rm/del, and mv/move/ren. It delegates to workspace-scoped file and fixed-command backends; arbitrary executables, pipes, redirection, chaining, substitutions, recursive deletion, and shell=True remain forbidden. rm and overwrite moves require confirm=true.",
} as const;

function fail(tool: string, error: unknown) {
  if (error instanceof AppToolError) return errorResult(tool, error.message);
  if (error instanceof Error) return errorResult(tool, error.message);
  return errorResult(tool, String(error));
}

/** 参数来自模型，可能缺失；保持旧实现的默认值。 */
function asNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function createWorkspaceTools(deps: AppToolDeps): AppTool[] {
  const fs = deps.workspace;
  return [
    makeAppTool({
      name: "workspace_status",
      description: WORKSPACE_DESCRIPTIONS.status,
      parameters: { type: "object", properties: {} },
      replay: "safe",
      async execute() {
        try {
          const status = await fs.status();
          return okResult("workspace_status", renderValue(status as unknown as JsonValue), {
            tool: "workspace_status",
            ...(status as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_status", error);
        }
      },
    }),
    makeAppTool<{ pattern: string; path?: string; max_results?: number; cursor?: number }>({
      name: "workspace_glob",
      description: WORKSPACE_DESCRIPTIONS.glob,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: {
            type: "string",
            description: "Optional root/base. Omit for the mounted user workspace; otherwise use workspace://user, workspace://uploads, workspace://outputs, or workspace://mcp.",
          },
          max_results: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "integer", minimum: 0 },
        },
        required: ["pattern"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const result = await fs.glob(
            args.pattern ?? "**/*",
            args.path ?? "",
            asNumber(args.max_results, 20),
            asNumber(args.cursor, 0),
          );
          return okResult("workspace_glob", renderValue(result as unknown as JsonValue), {
            tool: "workspace_glob",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_glob", error);
        }
      },
    }),
    makeAppTool<{ pattern: string; path?: string; include?: string; max_results?: number }>({
      name: "workspace_grep",
      description: WORKSPACE_DESCRIPTIONS.grep,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          include: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["pattern"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const result = await fs.grep(
            args.pattern ?? "",
            args.path ?? ".",
            args.include ?? "*",
            asNumber(args.max_results, 20),
          );
          return okResult("workspace_grep", renderValue(result as unknown as JsonValue), {
            tool: "workspace_grep",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_grep", error);
        }
      },
    }),
    makeAppTool<{ file_path: string; offset?: number; limit?: number; sheet_name?: string }>({
      name: "workspace_read_file",
      description: WORKSPACE_DESCRIPTIONS.read,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 400 },
          sheet_name: { type: "string", description: "Optional worksheet name for spreadsheet files; defaults to the first sheet." },
        },
        required: ["file_path"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const result = await fs.readFile(
            args.file_path ?? "",
            asNumber(args.offset, 0),
            asNumber(args.limit, 200),
            args.sheet_name ?? "",
          );
          return okResult("workspace_read_file", renderValue(result as unknown as JsonValue), {
            tool: "workspace_read_file",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_read_file", error);
        }
      },
    }),
    makeAppTool<{ file_path: string; content: string }>({
      name: "workspace_write_file",
      description: WORKSPACE_DESCRIPTIONS.write,
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" }, content: { type: "string" } },
        required: ["file_path", "content"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await fs.writeFile(args.file_path ?? "", args.content ?? "");
          return okResult("workspace_write_file", renderValue(result as unknown as JsonValue), {
            tool: "workspace_write_file",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_write_file", error);
        }
      },
    }),
    makeAppTool<{ file_path: string; old_string: string; new_string: string }>({
      name: "workspace_edit_file",
      description: WORKSPACE_DESCRIPTIONS.edit,
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["file_path", "old_string", "new_string"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await fs.editFile(args.file_path ?? "", args.old_string ?? "", args.new_string ?? "");
          return okResult("workspace_edit_file", renderValue(result as unknown as JsonValue), {
            tool: "workspace_edit_file",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_edit_file", error);
        }
      },
    }),
    makeAppTool<{ file_path: string; confirm: boolean }>({
      name: "workspace_delete_file",
      description: WORKSPACE_DESCRIPTIONS.delete,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          confirm: { type: "boolean", description: "Must be true after confirming the exact file path to delete." },
        },
        required: ["file_path", "confirm"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await fs.deleteFile(args.file_path ?? "", args.confirm === true);
          return okResult("workspace_delete_file", renderValue(result as unknown as JsonValue), {
            tool: "workspace_delete_file",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_delete_file", error);
        }
      },
    }),
    makeAppTool<{ source_path: string; destination_path: string; confirm_overwrite?: boolean }>({
      name: "workspace_move_file",
      description: WORKSPACE_DESCRIPTIONS.move,
      parameters: {
        type: "object",
        properties: {
          source_path: { type: "string" },
          destination_path: { type: "string" },
          confirm_overwrite: { type: "boolean" },
        },
        required: ["source_path", "destination_path"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await fs.moveFile(
            args.source_path ?? "",
            args.destination_path ?? "",
            args.confirm_overwrite === true,
          );
          return okResult("workspace_move_file", renderValue(result as unknown as JsonValue), {
            tool: "workspace_move_file",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_move_file", error);
        }
      },
    }),
    makeAppTool<{ command: string; timeout?: number; confirm?: boolean }>({
      name: "workspace_bash",
      description: WORKSPACE_DESCRIPTIONS.bash,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "integer", minimum: 1, maximum: 120 },
          confirm: {
            type: "boolean",
            description: "Required for rm/del and for overwriting an existing mv destination.",
          },
        },
        required: ["command"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await fs.bash(args.command ?? "", asNumber(args.timeout, 30), args.confirm === true);
          const text = JSON.stringify(result);
          return okResult("workspace_bash", text, {
            tool: "workspace_bash",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("workspace_bash", error);
        }
      },
    }),
  ];
}
