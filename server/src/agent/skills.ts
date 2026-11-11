/**
 * File-based analysis Skills: SKILL.md parsing, multi-source loading with precedence, prompt
 * rendering, activation (audited tool restriction) and the per-turn activation contract.
 *
 * Port of `agent/skills/{models,parser,loader,executor,registry}.py`, `agent/activation.py` and the
 * Skill-specific helpers in `agent/agent.py`. (`agent/skills.py` is shadowed by the `agent/skills/`
 * package in Python and is dead code; the package is the behavioural spec.)
 *
 * Directory priority (low → high, a later layer overrides by name): builtin (`<resources>/skills`),
 * user, workspace (`<workspace root>/.baa/skills`, see {@link WORKSPACE_SKILLS_SUBDIR}). All
 * directories are parameters; nothing here reads `~` or the environment.
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  PyDecodeError,
  isMapping,
  mapGet,
  osErrorText,
  pyCompare,
  pyLen,
  pyRepr,
  pyStr,
  pyStrip,
  PY_SPACE,
  readTextUtf8,
} from "./py-compat.ts";

export const MAX_SKILL_BYTES = 100_000;
export const MAX_PROMPT_CHARS = 50_000;
export const MAX_DESCRIPTION_CHARS = 240;
export const MAX_RESOURCE_FILES = 200;
export const RESOURCE_DIRS = ["references", "scripts", "assets"] as const;
export const MAX_SKILL_TAGS = 12;
export const ANALYSIS_MODES: Readonly<Record<string, true>> = { business: true, ml: true, empirical: true };
/** Workspace-level skills live in `<workspace root>/.baa/skills`. */
export const WORKSPACE_SKILLS_SUBDIR = join(".baa", "skills");

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SKILL_TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FRONTMATTER_RE = new RegExp(`^---[${PY_SPACE}]*\\r?\\n([\\s\\S]*?)\\r?\\n---[${PY_SPACE}]*(?:\\r?\\n|$)`);
const SKILL_SOURCES: Readonly<Record<SkillSource, true>> = { builtin: true, user: true, workspace: true, workflow: true };

export type SkillSource = "builtin" | "user" | "workspace" | "workflow";

export class SkillError extends Error {}

export type SkillResource = Readonly<{
  kind: (typeof RESOURCE_DIRS)[number];
  relativePath: string;
  path: string;
  size: number;
}>;

export type SkillDef = Readonly<{
  name: string;
  description: string;
  prompt: string;
  path: string;
  icon: string;
  allowedTools: readonly string[];
  tags: readonly string[];
  source: SkillSource;
  resources: readonly SkillResource[];
  displayName: string;
}>;

export type SkillDirs = {
  /** Project-bundled skills. */
  builtinDir?: string;
  userDir?: string;
  workspaceDir?: string;
};

export type SkillDiagnostic = Readonly<{ path: string; source: string; error: string }>;

/** `normalize_skill_tags`: validates and normalises ordered, multi-valued Skill tags. */
export function normalizeSkillTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new SkillError("tags must be a list of tag IDs");
  }
  const tags = value.map((item) => pyStrip(item).toLowerCase());
  if (tags.length > MAX_SKILL_TAGS) throw new SkillError(`skill has more than ${MAX_SKILL_TAGS} tags`);
  if (tags.some((tag) => !tag || !SKILL_TAG_RE.test(tag))) {
    throw new SkillError("tags must use lowercase letters, digits, and hyphens");
  }
  if (new Set(tags).size !== tags.length) throw new SkillError("duplicate skill tags are not allowed");
  return tags;
}

/** `SkillDef.__post_init__` validation, then construction. */
export function makeSkillDef(fields: {
  name: string;
  description: string;
  prompt: string;
  path: string;
  icon?: string;
  allowedTools?: readonly string[];
  tags?: readonly string[];
  source?: SkillSource;
  resources?: readonly SkillResource[];
  displayName?: string;
}): SkillDef {
  const def: SkillDef = {
    icon: "🧩",
    allowedTools: [],
    tags: [],
    source: "builtin",
    resources: [],
    displayName: "",
    ...fields,
  };
  if (!Object.hasOwn(SKILL_SOURCES, def.source)) throw new SkillError(`invalid skill source: ${pyRepr(def.source)}`);
  if (!SKILL_NAME_RE.test(def.name)) throw new SkillError(`invalid skill name: ${pyRepr(def.name)}`);
  if (!pyStrip(def.description)) throw new SkillError("skill description is required");
  if (!pyStrip(def.prompt)) throw new SkillError("skill prompt is required");
  if (new Set(def.allowedTools).size !== def.allowedTools.length) {
    throw new SkillError(`duplicate allowed tools for skill ${pyRepr(def.name)}`);
  }
  normalizeSkillTags(def.tags);
  return def;
}

export type SkillPublic = Readonly<{
  name: string;
  displayName: string;
  description: string;
  icon: string;
  source: SkillSource;
  tags: string[];
}>;

/** `to_public_dict` */
export function skillToPublic(skill: SkillDef): SkillPublic {
  return {
    name: skill.name,
    displayName: skill.displayName || skill.name,
    description: skill.description,
    icon: skill.icon,
    source: skill.source,
    tags: [...skill.tags],
  };
}

/** Whether this Skill declares itself available for an analysis mode (`mode-<mode>` tag). */
export function skillSupportsAnalysisMode(skill: SkillDef, mode: string): boolean {
  const normalized = pyStrip(mode || "").toLowerCase();
  return Object.hasOwn(ANALYSIS_MODES, normalized) && skill.tags.includes(`mode-${normalized}`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `sorted(root.rglob("*"), key=lambda item: str(item).lower())` restricted to what the caller uses. */
function walkEntries(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      found.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return found.sort((a, b) => pyCompare(a.toLowerCase(), b.toLowerCase()));
}

function discoverResources(skillDir: string): SkillResource[] {
  const resources: SkillResource[] = [];
  for (const kind of RESOURCE_DIRS) {
    const root = join(skillDir, kind);
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir || isSymlink(root)) continue;
    for (const path of walkEntries(root)) {
      if (resources.length >= MAX_RESOURCE_FILES) {
        throw new SkillError(`skill has more than ${MAX_RESOURCE_FILES} resource files`);
      }
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        throw new SkillError(`cannot inspect skill resource: ${osErrorText(error, path)}`);
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      resources.push({ kind, relativePath: relative(skillDir, path).split(sep).join("/"), path, size: stat.size });
    }
  }
  return resources;
}

/** `parse_skill_file`: strict, non-executable parser for one SKILL.md. */
export function parseSkillFile(path: string, source: SkillSource = "builtin"): SkillDef {
  let raw: string;
  try {
    if (isSymlink(path)) throw new SkillError("SKILL.md symlinks are not allowed");
    if (statSync(path).size > MAX_SKILL_BYTES) throw new SkillError(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
    raw = readTextUtf8(path);
  } catch (error) {
    if (error instanceof SkillError) throw error;
    // Python lets UnicodeDecodeError escape and crash the whole load; here it is a per-file diagnostic.
    if (error instanceof PyDecodeError) throw new SkillError(`cannot read skill file: ${error.message}`);
    throw new SkillError(`cannot read skill file: ${osErrorText(error, path)}`);
  }

  const clean = raw.replace(/^\uFEFF+/, "");
  const match = FRONTMATTER_RE.exec(clean);
  if (!match) throw new SkillError("missing YAML frontmatter");
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new SkillError(`invalid YAML frontmatter: ${(error as Error).message}`);
  }
  if (!isMapping(meta)) throw new SkillError("frontmatter must be a mapping");

  const name = pyStrip(pyStr(mapGet(meta, "name", "")));
  const description = pyStrip(pyStr(mapGet(meta, "description", "")));
  const icon = pyStrip(pyStr(mapGet(meta, "icon", "🧩"))) || "🧩";
  const prompt = pyStrip(clean.slice(match[0].length));
  const allowedTools = mapGet(meta, "allowedTools", []);
  if (!Array.isArray(allowedTools) || !allowedTools.every((item) => typeof item === "string")) {
    throw new SkillError("allowedTools must be a list of tool names");
  }
  const tags = normalizeSkillTags(mapGet(meta, "tags", []));
  if (pyLen(description) > MAX_DESCRIPTION_CHARS) {
    throw new SkillError(`description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (pyLen(prompt) > MAX_PROMPT_CHARS) throw new SkillError(`skill prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (pyLen(icon) > 8) throw new SkillError("icon is too long");

  const resources = basename(path).toUpperCase() === "SKILL.MD" ? discoverResources(dirname(path)) : [];
  return makeSkillDef({ name, description, prompt, path, icon, allowedTools, tags, source, resources });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Direct `*.md` files (sorted) followed by `*\/SKILL.md` packages (sorted). */
function candidateFiles(root: string | undefined): string[] {
  if (root === undefined || !isDirectory(root)) return [];
  const names = readdirSync(root);
  const direct = names.filter((name) => name.endsWith(".md") && isFile(join(root, name))).sort(pyCompare);
  const nested = names.filter((name) => isFile(join(root, name, "SKILL.md"))).sort(pyCompare);
  return [...direct.map((name) => join(root, name)), ...nested.map((name) => join(root, name, "SKILL.md"))];
}

/**
 * Multi-source Skill discovery: workspace > user > builtin, higher layers override by name; within one
 * source the first file (direct `*.md` before nested `SKILL.md`, each sorted by name) wins.
 */
export class SkillLoader {
  readonly dirs: SkillDirs;
  #skills = new Map<string, SkillDef>();
  #cache = new Map<string, SkillDef>();
  #diagnostics: SkillDiagnostic[] = [];

  constructor(dirs: SkillDirs) {
    this.dirs = dirs;
  }

  #scan(root: string | undefined, source: SkillSource): SkillDef[] {
    const found: SkillDef[] = [];
    const seen = new Set<string>();
    for (const path of candidateFiles(root)) {
      let skill: SkillDef;
      try {
        skill = parseSkillFile(path, source);
      } catch (error) {
        if (!(error instanceof SkillError)) throw error;
        this.#diagnostics.push({ path, source, error: error.message });
        continue;
      }
      if (seen.has(skill.name)) {
        this.#diagnostics.push({ path, source, error: `duplicate skill name in ${source} source: ${skill.name}` });
        continue;
      }
      seen.add(skill.name);
      found.push(skill);
    }
    return found;
  }

  loadAll(): Map<string, SkillDef> {
    this.#diagnostics = [];
    const merged = new Map<string, SkillDef>();
    // Low-to-high precedence; assignment by a later layer is intentional.
    for (const [root, source] of [
      [this.dirs.builtinDir, "builtin"],
      [this.dirs.userDir, "user"],
      [this.dirs.workspaceDir, "workspace"],
    ] as const) {
      for (const skill of this.#scan(root, source)) merged.set(skill.name, skill);
    }
    this.#skills = merged;
    for (const [name, skill] of merged) this.#cache.set(name, skill);
    return new Map(merged);
  }

  /** Re-parses the file so edits hot-reload between turns; a broken edit falls back to the last good copy. */
  get(name: string): SkillDef | undefined {
    const skill = this.#skills.get(name);
    if (skill === undefined) return undefined;
    let fresh: SkillDef;
    try {
      fresh = parseSkillFile(skill.path, skill.source);
    } catch (error) {
      if (!(error instanceof SkillError)) throw error;
      return this.#cache.get(name) ?? skill;
    }
    if (fresh.name !== name) return this.#cache.get(name) ?? skill;
    this.#skills.set(name, fresh);
    this.#cache.set(name, fresh);
    return fresh;
  }

  diagnostics(): readonly SkillDiagnostic[] {
    return [...this.#diagnostics];
  }

  catalog(): SkillDef[] {
    return [...this.#skills.values()];
  }
}

export function loadSkills(dirs: SkillDirs): Map<string, SkillDef> {
  return new SkillLoader(dirs).loadAll();
}

/** Resolve on demand so edited skill files hot-reload between turns. */
export function getSkill(name: string, dirs: SkillDirs): SkillDef | undefined {
  const loader = new SkillLoader(dirs);
  loader.loadAll();
  return loader.get(name);
}

/** Substitute `$ARGUMENTS`, or append the request when no placeholder exists; then list bundled resources. */
export function renderSkillPrompt(skill: SkillDef, userRequest: string): string {
  const request = pyStrip(userRequest || "");
  let prompt: string;
  if (skill.prompt.includes("$ARGUMENTS")) prompt = skill.prompt.replaceAll("$ARGUMENTS", () => request);
  else if (request) prompt = `${skill.prompt}\n\n## User request\n\n${request}`;
  else prompt = skill.prompt;
  if (skill.resources.length > 0) {
    const index = skill.resources.map((r) => `- ${r.relativePath} (${r.kind}, ${r.size} bytes)`).join("\n");
    prompt +=
      "\n\n## Bundled resources\n" +
      "Load only the specific resource needed for the current request. " +
      "Scripts are resources and are not automatically executable.\n" +
      index;
  }
  return prompt;
}

export class SkillDependencyError extends Error {}

export type SkillActivation = Readonly<{
  name: string;
  prompt: string;
  requestedTools: ReadonlySet<string>;
  resources: readonly SkillResource[];
}>;

/**
 * `SkillExecutor.activate`. `knownTools` is the set of registered (audited) tool names, i.e.
 * Python's `BUILTIN_TOOL_REGISTRY.names()`.
 */
export function activateSkill(skill: SkillDef, userRequest: string, knownTools: ReadonlySet<string>): SkillActivation {
  const missing = skill.allowedTools.filter((tool) => !knownTools.has(tool));
  if (missing.length > 0) {
    const names = [...new Set(missing)].sort(pyCompare).join(", ");
    throw new SkillDependencyError(`Skill ${pyRepr(skill.name)} requires unregistered tools: ${names}`);
  }
  return {
    name: skill.name,
    prompt: renderSkillPrompt(skill, userRequest),
    requestedTools: new Set(skill.allowedTools),
    resources: skill.resources,
  };
}

/** Restrict an already-authorized tool set; a Skill can only reduce it, never activate a hidden tool. */
export function filterExposedTools(activation: SkillActivation, exposed: ReadonlySet<string>): Set<string> {
  if (activation.requestedTools.size === 0) return new Set(exposed);
  return new Set([...exposed].filter((tool) => activation.requestedTools.has(tool)));
}

// ── agent.py Skill policy ────────────────────────────────────────────────────────────────────────

/** Built-in Skills whose activation also selects the same-named output command. */
export const SKILL_COMMAND_NAMES: Readonly<Record<string, true>> = { export: true, report: true, ppt: true, dashboard: true };

/**
 * Only project-bundled Skills may unlock their audited proposal tool; a workspace/user Skill with the
 * same name cannot inherit it. Workflow Skills share one policy token.
 */
export function trustedSkillName(skill: SkillDef): string {
  if (skill.source === "builtin") return skill.name;
  if (skill.source === "workflow") return "workflow";
  return "";
}

const REQUIRED_SUCCESSFUL_SKILL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "ab-test-analysis": ["run_analysis"],
  regression: ["run_analysis"],
};

/** Required Skill tools that have not completed successfully (sorted). */
export function missingRequiredSkillTools(skillName: string, successfulTools: ReadonlySet<string>): string[] {
  const key = skillName || "";
  const required = Object.hasOwn(REQUIRED_SUCCESSFUL_SKILL_TOOLS, key) ? REQUIRED_SUCCESSFUL_SKILL_TOOLS[key]! : [];
  return required.filter((tool) => !successfulTools.has(tool)).sort(pyCompare);
}

const REGRESSION_RESPONSE_REQUIREMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["相关方向（明确写出负相关/负线性）", ["负相关", "负线性", "negative correlation", "negative relationship"]],
  ["显著性（说明显著或不显著，并给出 p 值口径）", ["显著", "p值", "p 值", "p-value", "p value"]],
  ["非因果边界（明确相关不等于因果）", ["因果", "causal", "causality"]],
];

/** Deterministic final-answer obligations for selected Skills (currently only `regression`). */
export function missingSkillResponseContract(skillName: string, content: string): string[] {
  if ((skillName || "") !== "regression") return [];
  const text = (content || "").toLowerCase();
  return REGRESSION_RESPONSE_REQUIREMENTS.filter(([, tokens]) => !tokens.some((token) => text.includes(token))).map(
    ([label]) => label,
  );
}

/** Stop ReAct tool use once a terminal analysis Skill has its result. */
export function skillRequiresTextOnly(skillName: string, successfulTools: ReadonlySet<string>): boolean {
  return (skillName || "") === "regression" && missingRequiredSkillTools(skillName, successfulTools).length === 0;
}

// ── activation.py ────────────────────────────────────────────────────────────────────────────────

export const INTERNAL_ACTIONS: Readonly<Record<string, true>> = {
  ppt_confirm: true,
  ppt_revise: true,
  excel_confirm: true,
  excel_revise: true,
  report_confirm: true,
  report_revise: true,
  dashboard_confirm: true,
  dashboard_revise: true,
};

/** Exactly one explicit activation may own a conversation turn. */
export type ActivationContext = Readonly<{ skillName: string; commandName: string; internalAction: string }>;

export function createActivation(fields: Partial<ActivationContext> = {}): ActivationContext {
  const activation = { skillName: "", commandName: "", internalAction: "", ...fields };
  const active = [activation.skillName, activation.commandName, activation.internalAction].filter(Boolean).length;
  if (active > 1) throw new Error("skill, command, and internal_action are mutually exclusive");
  return activation;
}

export type ActivationRecord = Readonly<{
  kind: "skill" | "command" | "internal_action" | "none";
  name: string;
  skillName: string;
  commandName: string;
  internalAction: string;
}>;

/** Stable persisted/audited representation with explicit namespaces (`ActivationContext.to_record`). */
export function activationRecord(activation: ActivationContext): ActivationRecord {
  const kind = activation.skillName
    ? "skill"
    : activation.commandName
      ? "command"
      : activation.internalAction
        ? "internal_action"
        : "none";
  return {
    kind,
    name: activation.skillName || activation.commandName || activation.internalAction,
    skillName: activation.skillName,
    commandName: activation.commandName,
    internalAction: activation.internalAction,
  };
}
