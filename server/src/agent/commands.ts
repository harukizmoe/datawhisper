/**
 * Slash Commands: Markdown command files with frontmatter, protected built-ins, user/workspace
 * overrides, alias registry, slash parsing, prompt rendering, availability and dispatch.
 *
 * Port of `agent/commands/{models,parser,catalog,loader,registry,dispatcher,availability}.py`.
 * Precedence: protected built-ins (`commands/*.md`, trusted types allowed) > workspace > user for
 * *new* names; a user/workspace file can never replace a protected built-in. Directories are
 * parameters; workspace commands live in `<workspace root>/.baa/commands`.
 *
 * Differences from Python: no process-wide directory-fingerprint cache (loading 17 small files per
 * turn is cheaper than fingerprinting), and invalid UTF-8 is a per-file diagnostic instead of an
 * uncaught `UnicodeDecodeError`.
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  PY_SPACE,
  PyDecodeError,
  isMapping,
  mapGet,
  osErrorText,
  pyCompare,
  pyLen,
  pyRepr,
  pyStr,
  pyStrip,
  pySuffix,
  readTextUtf8,
} from "./py-compat.ts";

export const MAX_COMMAND_BYTES = 100_000;
export const MAX_PROMPT_CHARS = 50_000;
export const MAX_COMMAND_NAME_CHARS = 80;
export const MAX_COMMAND_ALIASES = 12;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_USAGE_CHARS = 300;
export const MAX_ARGUMENT_HINT_CHARS = 300;
export const MAX_ICON_CHARS = 16;
export const MAX_CATEGORY_CHARS = 64;
/** Workspace-level commands live in `<workspace root>/.baa/commands`. */
export const WORKSPACE_COMMANDS_SUBDIR = join(".baa", "commands");

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const COMMAND_ALIAS_RE = /^(?:[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*|\?)$/;
const FRONTMATTER_RE = new RegExp(`^---[${PY_SPACE}]*\\r?\\n([\\s\\S]*?)\\r?\\n---[${PY_SPACE}]*(?:\\r?\\n|$)`);
const TRUSTED_ONLY_FIELDS = ["confirmation", "handler-key", "uses-model"]; // sorted, as Python sorts them
const COMMAND_TYPES: Readonly<Record<string, true>> = { local: true, "local-ui": true, backend: true, prompt: true };
const ARGUMENT_MODES: Readonly<Record<string, true>> = { none: true, optional: true, required: true };

export type CommandType = "local" | "local-ui" | "backend" | "prompt";
export type CommandSource = "builtin" | "user" | "workspace";
export type CommandArguments = "none" | "optional" | "required";
export type CommandConfirmation = "none" | "confirm";

export class CommandError extends Error {}
export class CommandDispatchError extends Error {}

export type CommandDef = Readonly<{
  name: string;
  description: string;
  type: CommandType;
  aliases: readonly string[];
  usage: string;
  argumentHint: string;
  arguments: CommandArguments;
  icon: string;
  category: string;
  prompt: string;
  handlerKey: string;
  hidden: boolean;
  protected: boolean;
  usesModel: boolean;
  confirmation: CommandConfirmation;
  source: CommandSource;
  path: string | null;
}>;

/** `CommandDef.__post_init__` validation, then construction. Throws {@link CommandError}. */
export function makeCommandDef(
  fields: Pick<CommandDef, "name" | "description" | "type"> & Partial<CommandDef>,
): CommandDef {
  const def: CommandDef = {
    aliases: [],
    usage: "",
    argumentHint: "",
    arguments: "none",
    icon: "⌘",
    category: "tools",
    prompt: "",
    handlerKey: "",
    hidden: false,
    protected: false,
    usesModel: false,
    confirmation: "none",
    source: "builtin",
    path: null,
    ...fields,
  };
  if (!Object.hasOwn(COMMAND_TYPES, def.type)) throw new CommandError(`invalid command type: ${pyRepr(def.type)}`);
  if (!COMMAND_NAME_RE.test(def.name)) throw new CommandError(`invalid command name: ${pyRepr(def.name)}`);
  if (pyLen(def.name) > MAX_COMMAND_NAME_CHARS) {
    throw new CommandError(`command name exceeds ${MAX_COMMAND_NAME_CHARS} characters`);
  }
  if (!pyStrip(def.description)) throw new CommandError("command description is required");
  if (pyLen(def.description) > MAX_DESCRIPTION_CHARS) {
    throw new CommandError(`command description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (def.aliases.length > MAX_COMMAND_ALIASES) {
    throw new CommandError(`command has more than ${MAX_COMMAND_ALIASES} aliases`);
  }
  if (new Set(def.aliases).size !== def.aliases.length) {
    throw new CommandError(`duplicate aliases for command ${pyRepr(def.name)}`);
  }
  for (const alias of def.aliases) {
    if (!COMMAND_ALIAS_RE.test(alias)) throw new CommandError(`invalid command alias: ${pyRepr(alias)}`);
    if (alias === def.name) throw new CommandError(`command alias duplicates its name: ${pyRepr(alias)}`);
  }
  if (!Object.hasOwn(ARGUMENT_MODES, def.arguments)) {
    throw new CommandError(`invalid command arguments mode: ${pyRepr(def.arguments)}`);
  }
  if (def.confirmation !== "none" && def.confirmation !== "confirm") {
    throw new CommandError(`invalid command confirmation mode: ${pyRepr(def.confirmation)}`);
  }
  for (const [label, value, limit] of [
    ["usage", def.usage, MAX_USAGE_CHARS],
    ["argument hint", def.argumentHint, MAX_ARGUMENT_HINT_CHARS],
    ["icon", def.icon, MAX_ICON_CHARS],
    ["category", def.category, MAX_CATEGORY_CHARS],
  ] as const) {
    if (pyLen(value) > limit) throw new CommandError(`command ${label} exceeds ${limit} characters`);
  }
  if (def.type === "prompt" && !pyStrip(def.prompt)) {
    throw new CommandError(`prompt command ${pyRepr(def.name)} requires prompt text`);
  }
  if (def.type !== "prompt" && !pyStrip(def.handlerKey)) {
    throw new CommandError(`${def.type} command ${pyRepr(def.name)} requires handler_key`);
  }
  if (def.usesModel && !def.protected) throw new CommandError("only protected commands may declare uses_model");
  if (def.confirmation !== "none" && !def.protected) {
    throw new CommandError("only protected commands may declare confirmation");
  }
  return def;
}

export type CommandAvailability = Readonly<{ available: boolean; code: string; reason: string }>;

/** `to_public_dict`: the catalog entry sent to the UI. Backend handler keys are never exposed. */
export function commandToPublic(command: CommandDef, availability?: CommandAvailability) {
  const payload: Record<string, unknown> = {
    name: command.name,
    description: command.description,
    type: command.type,
    aliases: [...command.aliases],
    usage: command.usage,
    argumentHint: command.argumentHint,
    arguments: command.arguments,
    icon: command.icon,
    category: command.category,
    source: command.source,
    available: true,
    usesModel: command.usesModel,
    confirmation: command.confirmation,
  };
  if (availability) {
    payload.available = availability.available;
    payload.unavailableCode = availability.code;
    payload.unavailableReason = availability.reason;
  }
  if (
    (command.type === "local" || command.type === "local-ui") &&
    command.protected &&
    command.handlerKey.startsWith("client:")
  ) {
    payload.clientAction = command.handlerKey.slice("client:".length);
  }
  return payload;
}

/** `relative.with_suffix("")` parts, lower-cased, spaces → `-`, joined by `:`. */
export function commandNameFromPath(baseDir: string, path: string): string {
  const rel = relative(baseDir, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    throw new CommandError("command file is outside its source directory");
  }
  const parts = rel.split(sep);
  const last = parts[parts.length - 1]!;
  parts[parts.length - 1] = last.slice(0, last.length - pySuffix(last).length);
  return parts.map((part) => part.toLowerCase().replaceAll(" ", "-")).join(":");
}

/** `parse_command_file` */
export function parseCommandFile(
  baseDir: string,
  path: string,
  options: { source?: CommandSource; allowTrustedTypes?: boolean } = {},
): CommandDef {
  const { source = "user", allowTrustedTypes = false } = options;
  let raw: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new CommandError("command symlinks are not allowed");
    if (statSync(path).size > MAX_COMMAND_BYTES) throw new CommandError(`command file exceeds ${MAX_COMMAND_BYTES} bytes`);
    raw = readTextUtf8(path).replace(/^\uFEFF+/, "");
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (error instanceof PyDecodeError) throw new CommandError(`cannot read command file: ${error.message}`);
    throw new CommandError(`cannot read command file: ${osErrorText(error, path)}`);
  }

  const match = FRONTMATTER_RE.exec(raw);
  if (!match) throw new CommandError("missing YAML frontmatter");
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new CommandError(`invalid YAML frontmatter: ${(error as Error).message}`);
  }
  if (!isMapping(meta)) throw new CommandError("frontmatter must be a mapping");

  const name = commandNameFromPath(baseDir, path);
  const body = pyStrip(raw.slice(match[0].length));
  if (pyLen(body) > MAX_PROMPT_CHARS) throw new CommandError(`command prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  const description = pyStrip(pyStr(mapGet(meta, "description", "")));
  const aliases = mapGet(meta, "aliases", []);
  if (!Array.isArray(aliases) || !aliases.every((item) => typeof item === "string")) {
    throw new CommandError("aliases must be a list of command names");
  }
  const commandType = pyStrip(pyStr(mapGet(meta, "type", "prompt"))).toLowerCase();
  if (!allowTrustedTypes && commandType !== "prompt") {
    throw new CommandError("custom Markdown commands may only use type: prompt");
  }
  if (!allowTrustedTypes) {
    const forbidden = TRUSTED_ONLY_FIELDS.filter((field) => Object.hasOwn(meta, field));
    if (forbidden.length > 0) {
      throw new CommandError(`custom Markdown commands cannot declare trusted fields: ${forbidden.join(", ")}`);
    }
  }
  if (!Object.hasOwn(COMMAND_TYPES, commandType)) throw new CommandError(`invalid command type: ${commandType}`);
  const hidden = mapGet(meta, "hidden", false);
  const usesModel = mapGet(meta, "uses-model", false);
  if (typeof hidden !== "boolean") throw new CommandError("hidden must be a boolean");
  if (typeof usesModel !== "boolean") throw new CommandError("uses-model must be a boolean");

  return makeCommandDef({
    name,
    description: description || `Custom command: ${name}`,
    type: commandType as CommandType,
    aliases: aliases.map((item) => pyStrip(item).toLowerCase()),
    usage: pyStrip(pyStr(mapGet(meta, "usage", ""))),
    argumentHint: pyStrip(pyStr(mapGet(meta, "argument-hint", ""))),
    arguments: pyStrip(pyStr(mapGet(meta, "arguments", commandType === "prompt" ? "optional" : "none"))).toLowerCase() as CommandArguments,
    icon: pyStrip(pyStr(mapGet(meta, "icon", "⌘"))) || "⌘",
    category: pyStrip(pyStr(mapGet(meta, "category", "custom"))) || "custom",
    prompt: body,
    handlerKey: allowTrustedTypes ? pyStrip(pyStr(mapGet(meta, "handler-key", ""))) : "",
    hidden,
    protected: allowTrustedTypes,
    usesModel: allowTrustedTypes ? usesModel : false,
    confirmation: (allowTrustedTypes ? pyStrip(pyStr(mapGet(meta, "confirmation", "none"))).toLowerCase() : "none") as CommandConfirmation,
    source,
    path,
  });
}

/** Every `*.md` entry under `root` (files, dirs and symlinks; symlinked dirs are not entered). */
function rglobMarkdown(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".md")) found.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return found;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Single source of truth for slash-command names and aliases. */
export class CommandRegistry {
  #commands = new Map<string, CommandDef>();
  #aliases = new Map<string, string>();
  #frozen = false;

  constructor(commands: Iterable<CommandDef> = []) {
    for (const command of commands) this.register(command);
  }

  register(command: CommandDef): void {
    if (this.#frozen) throw new Error("command registry snapshot is immutable");
    const occupied = (key: string) => this.#commands.has(key) || this.#aliases.has(key);
    if (occupied(command.name)) {
      throw new CommandError(`command name conflicts with existing name/alias: ${command.name}`);
    }
    for (const alias of command.aliases) {
      if (occupied(alias)) throw new CommandError(`command alias conflicts with existing name/alias: ${alias}`);
    }
    this.#commands.set(command.name, command);
    for (const alias of command.aliases) this.#aliases.set(alias, command.name);
  }

  /** Prevent mutation so readers can safely share this snapshot. */
  freeze(): this {
    this.#frozen = true;
    return this;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  get(nameOrAlias: string): CommandDef | undefined {
    return this.#commands.get(this.#aliases.get(nameOrAlias) ?? nameOrAlias);
  }

  all(includeHidden = false): CommandDef[] {
    return [...this.#commands.values()].filter((command) => includeHidden || !command.hidden);
  }
}

// Packaging fallback for installations missing the command content folder: [name, description, icon, category].
const FALLBACK: ReadonlyArray<readonly [string, string, string, string]> = [
  ["help", "查看智析 Agent 可用命令及使用方法", "❓", "tools"],
  ["clear", "清除当前对话内容，保留数据源、模型和工作目录连接", "🧹", "session"],
  ["compact", "立即压缩当前对话上下文，保留关键结论和最近内容", "🗜️", "session"],
  ["instruction", "设置仅对当前分析对话生效的临时指令", "📝", "session"],
  ["sessions", "刷新已保存对话，或新建分析对话", "💬", "session"],
  ["mcp", "打开 MCP 连接与工具管理", "🔌", "tools"],
  ["knowledge", "打开业务知识库，管理指标口径、规则和参考资料", "🧠", "tools"],
  ["workspace", "连接工作目录并设置只读或可编辑权限", "📁", "tools"],
  ["checkpoint", "查看对话快照并回退文件、对话或两者", "⏪", "tools"],
  ["status", "查看当前模型、数据源和 Token 上下文状态", "📡", "tools"],
  ["skills", "查看、选择或刷新数据分析 Skill", "🧩", "tools"],
  ["new", "新建一个干净的分析会话", "✨", "session"],
  ["stop", "停止当前正在生成的回复", "⏹️", "session"],
  ["data", "打开当前数据源和数据表预览", "🗂️", "tools"],
  ["jobs", "打开任务历史和运行状态", "🕘", "tools"],
  ["teams", "打开分析团队和沟通记录", "👥", "tools"],
];
const FALLBACK_ACTIONS: Readonly<Record<string, string>> = {
  instruction: "plan",
  sessions: "session",
  knowledge: "memory",
  workspace: "permission",
  checkpoint: "rewind",
  skills: "skill",
};
const FALLBACK_ALIASES: Readonly<Record<string, readonly string[]>> = {
  help: ["h", "?"],
  status: ["s"],
  compact: ["c"],
  instruction: ["i"],
  sessions: ["session"],
  knowledge: ["kb"],
  workspace: ["ws"],
  checkpoint: ["cp"],
  skills: ["sk"],
  new: ["n"],
};
const FALLBACK_LOCAL: Readonly<Record<string, true>> = { help: true, status: true };
const FALLBACK_OPTIONAL_ARGS: Readonly<Record<string, true>> = {
  help: true,
  compact: true,
  instruction: true,
  sessions: true,
  skills: true,
};

/**
 * Protected built-in catalog: every parseable `*.md` under `builtinDir` (trusted types allowed,
 * path-ordered); if none load, the hard-coded fallback list.
 */
export function builtinCommands(builtinDir: string | undefined): CommandDef[] {
  if (builtinDir !== undefined && isDirectory(builtinDir)) {
    const byParts = (a: string, b: string) => {
      const x = relative(builtinDir, a).split(sep);
      const y = relative(builtinDir, b).split(sep);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const order = pyCompare(x[i]!, y[i]!);
        if (order !== 0) return order;
      }
      return x.length - y.length;
    };
    const loaded: CommandDef[] = [];
    for (const path of rglobMarkdown(builtinDir).sort(byParts)) {
      try {
        loaded.push(parseCommandFile(builtinDir, path, { source: "builtin", allowTrustedTypes: true }));
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
      }
    }
    if (loaded.length > 0) return loaded;
  }
  return FALLBACK.map(([name, description, icon, category]) => {
    const own = <T>(table: Readonly<Record<string, T>>) => (Object.hasOwn(table, name) ? table[name] : undefined);
    const isCompact = name === "compact";
    return makeCommandDef({
      name,
      description,
      type: isCompact ? "backend" : own(FALLBACK_LOCAL) ? "local" : "local-ui",
      icon,
      category,
      aliases: own(FALLBACK_ALIASES) ?? [],
      arguments: own(FALLBACK_OPTIONAL_ARGS) ? "optional" : "none",
      handlerKey: isCompact ? "server:compact" : `client:${own(FALLBACK_ACTIONS) ?? name}`,
      protected: true,
      usesModel: isCompact,
    });
  });
}

export type CommandDiagnostic = Readonly<{ path: string; source: string; error: string }>;

export type CommandDirs = {
  /** Protected built-in `commands/` directory. */
  builtinDir?: string;
  userDir?: string;
  workspaceDir?: string;
};

/** Load protected built-ins plus workspace > user Markdown commands into a frozen registry snapshot. */
export function loadCommands(dirs: CommandDirs): { registry: CommandRegistry; diagnostics: CommandDiagnostic[] } {
  const diagnostics: CommandDiagnostic[] = [];
  const builtins = builtinCommands(dirs.builtinDir);
  const merged = new Map(builtins.map((command) => [command.name, command]));
  const protectedNames = new Set(builtins.filter((command) => command.protected).map((command) => command.name));

  for (const [root, source] of [
    [dirs.userDir, "user"],
    [dirs.workspaceDir, "workspace"],
  ] as const) {
    if (root === undefined || !isDirectory(root)) continue;
    // Python scans a whole source first (parse diagnostics), then applies the protected-name check.
    const parsed: CommandDef[] = [];
    for (const path of rglobMarkdown(root).sort((a, b) => pyCompare(a.toLowerCase(), b.toLowerCase()))) {
      try {
        parsed.push(parseCommandFile(root, path, { source }));
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        diagnostics.push({ path, source, error: error.message });
      }
    }
    for (const command of parsed) {
      if (protectedNames.has(command.name)) {
        diagnostics.push({
          path: command.path ?? "",
          source,
          error: `cannot override protected built-in command: ${command.name}`,
        });
        continue;
      }
      merged.set(command.name, command);
    }
  }

  const registry = new CommandRegistry();
  for (const command of merged.values()) {
    try {
      registry.register(command);
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      diagnostics.push({ path: command.path ?? "<builtin>", source: command.source, error: error.message });
    }
  }
  return { registry: registry.freeze(), diagnostics };
}

// ── dispatcher.py ────────────────────────────────────────────────────────────────────────────────

export type ParsedCommand = Readonly<{ name: string; arguments: string; isCommand: boolean }>;

const SLASH_SPLIT = new RegExp(`^[${PY_SPACE}]*([^${PY_SPACE}]+)(?:[${PY_SPACE}]+([\\s\\S]*))?$`);

/** `/Name args…` → lower-cased name and stripped argument text; anything else is not a command. */
export function parseSlashCommand(text: string): ParsedCommand {
  const stripped = pyStrip(text || "");
  if (!stripped.startsWith("/")) return { name: "", arguments: "", isCommand: false };
  const remainder = stripped.slice(1);
  const parts = SLASH_SPLIT.exec(remainder);
  if (!parts) return { name: "", arguments: "", isCommand: true };
  return { name: parts[1]!.toLowerCase(), arguments: pyStrip(parts[2] ?? ""), isCommand: true };
}

/** Substitute `$ARGUMENTS`, or append the request when the prompt has no placeholder. */
export function renderCommandPrompt(command: Pick<CommandDef, "prompt">, args: string): string {
  const trimmed = pyStrip(args || "");
  if (command.prompt.includes("$ARGUMENTS")) return command.prompt.replaceAll("$ARGUMENTS", () => trimmed);
  if (trimmed) return `${command.prompt}\n\n## User request\n\n${trimmed}`;
  return command.prompt;
}

export type CommandDispatchResult = Readonly<{ command: CommandDef; arguments: string; prompt: string; value: unknown }>;
export type CommandHandler = (args: string, context: unknown) => unknown;

/** Resolve a (case-insensitive) name or alias; unknown → {@link CommandDispatchError}. */
export function resolveCommand(registry: CommandRegistry, nameOrAlias: string): CommandDef {
  const command = registry.get((nameOrAlias || "").toLowerCase());
  if (command === undefined) throw new CommandDispatchError(`unknown slash command: ${nameOrAlias}`);
  return command;
}

/** Prepare only a prompt command for the Agent execution loop. */
export function prepareAgentTurn(registry: CommandRegistry, nameOrAlias: string, args = ""): CommandDispatchResult {
  const command = resolveCommand(registry, nameOrAlias);
  if (command.type !== "prompt") {
    throw new CommandDispatchError(`${command.type} command /${command.name} cannot run in the Agent`);
  }
  return { command, arguments: args, prompt: renderCommandPrompt(command, args), value: undefined };
}

/** Prompt commands render; other types call the handler registered under their `handlerKey`. */
export async function dispatchCommand(
  registry: CommandRegistry,
  handlers: Readonly<Record<string, CommandHandler>>,
  nameOrAlias: string,
  args = "",
  context: unknown = undefined,
): Promise<CommandDispatchResult> {
  const command = resolveCommand(registry, nameOrAlias);
  if (command.type === "prompt") return { command, arguments: args, prompt: renderCommandPrompt(command, args), value: undefined };
  const handler = Object.hasOwn(handlers, command.handlerKey) ? handlers[command.handlerKey] : undefined;
  if (handler === undefined) {
    throw new CommandDispatchError(`command /${command.name} handler is unavailable: ${command.handlerKey}`);
  }
  return { command, arguments: args, prompt: "", value: await handler(args, context) };
}

// ── availability.py ──────────────────────────────────────────────────────────────────────────────

export type CommandAvailabilityContext = Readonly<{
  historyLength: number;
  modelAvailable: boolean;
  workspaceMounted: boolean;
}>;

const AVAILABLE: CommandAvailability = { available: true, code: "", reason: "" };

/** Context-aware prerequisites of trusted commands; `null` context = a generic catalog. */
export function evaluateCommandAvailability(
  command: Pick<CommandDef, "name">,
  context: CommandAvailabilityContext | null,
): CommandAvailability {
  if (context === null) return AVAILABLE;
  if (command.name === "compact") {
    if (context.historyLength < 4) {
      return { available: false, code: "not_enough_context", reason: "当前对话内容较少，暂时不需要压缩。" };
    }
    if (!context.modelAvailable) return { available: false, code: "model_required", reason: "请先配置并选择模型。" };
  }
  if ((command.name === "checkpoint" || command.name === "teams") && !context.workspaceMounted) {
    return { available: false, code: "workspace_required", reason: "请先连接工作目录。" };
  }
  return AVAILABLE;
}
