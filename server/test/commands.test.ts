import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandDef,
  CommandDispatchError,
  CommandError,
  CommandRegistry,
  type CommandAvailabilityContext,
  builtinCommands,
  commandToPublic,
  dispatchCommand,
  evaluateCommandAvailability,
  loadCommands,
  parseCommandFile,
  parseSlashCommand,
  prepareAgentTurn,
  renderCommandPrompt,
  resolveCommand,
} from "../src/agent/commands.ts";
import { FIXTURES, GOLDEN, REPO_ROOT, materialize, relativeTo } from "./support/fs-spec.ts";

const golden = JSON.parse(readFileSync(join(GOLDEN, "commands.json"), "utf8"));
const commandFixtures = join(FIXTURES, "commands");
const builtinDir = join(REPO_ROOT, "commands");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function comparableError(error: string): string {
  return error.startsWith("invalid YAML frontmatter: ") ? "invalid YAML frontmatter: " : error;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const pyPublic = (command: CommandDef, availability?: Parameters<typeof commandToPublic>[1]) =>
  Object.fromEntries(Object.entries(commandToPublic(command, availability)).map(([k, v]) => [snake(k), v]));

function pyCommand(c: CommandDef, base = REPO_ROOT) {
  return {
    name: c.name,
    description: c.description,
    type: c.type,
    aliases: [...c.aliases],
    usage: c.usage,
    argument_hint: c.argumentHint,
    arguments: c.arguments,
    icon: c.icon,
    category: c.category,
    prompt: c.prompt,
    handler_key: c.handlerKey,
    hidden: c.hidden,
    protected: c.protected,
    uses_model: c.usesModel,
    confirmation: c.confirmation,
    source: c.source,
    path: c.path === null ? null : relativeTo(base, c.path),
    public: pyPublic(c),
  };
}

// Error texts may embed the temp directory; the generator stores it as "<tmp>".
const pyDiagnostics = (list: readonly { path: string; source: string; error: string }[], base = REPO_ROOT) =>
  list.map((d) => ({ path: relativeTo(base, d.path), source: d.source, error: comparableError(d.error.replaceAll(base, "<tmp>")) }));
const expectedDiagnostics = (list: { path: string; source: string; error: string }[]) =>
  list.map((d) => ({ ...d, error: comparableError(d.error) }));

describe("built-in commands (repo commands/)", () => {
  const builtins = builtinCommands(builtinDir);

  test("17 protected commands load with the Python fields, order and public form", () => {
    expect(golden.builtin.count).toBe(17);
    expect(builtins.length).toBe(17);
    expect(builtins.map((c) => pyCommand(c))).toEqual(golden.builtin.commands);
    for (const c of builtins) {
      expect(c.protected).toBe(true);
      expect(c.source).toBe("builtin");
    }
  });

  test("aliases include `?` and resolve case-sensitively through the registry", () => {
    const { registry } = loadCommands({ builtinDir });
    expect(registry.get("?")?.name).toBe("help");
    expect(registry.get("h")?.name).toBe("help");
    expect(registry.get("HELP")).toBeUndefined();
    expect(registry.get("constructor")).toBeUndefined();
    expect(registry.get("__proto__")).toBeUndefined();
  });

  test("fallback list when the commands folder is missing or empty", () => {
    const fallback = builtinCommands(join(commandFixtures, "no-such-dir"));
    expect(golden.fallback.count).toBe(16);
    expect(fallback.map((c) => pyCommand(c))).toEqual(golden.fallback.commands);
    const { registry, diagnostics } = loadCommands({ builtinDir: join(commandFixtures, "no-such-dir") });
    expect(registry.all(true).map((c) => c.name)).toEqual(golden.fallback.registry);
    expect(diagnostics.map((d) => d.error)).toEqual(golden.fallback.diagnostics);
  });
});

describe("user / workspace layering", () => {
  for (const c of golden.cases) {
    test(c.id, () => {
      const { registry, diagnostics } = loadCommands({
        builtinDir,
        userDir: c.user ? join(commandFixtures, c.user) : undefined,
        workspaceDir: c.workspace ? join(commandFixtures, c.workspace) : undefined,
      });
      expect(registry.frozen).toBe(true);
      expect(registry.all(true).map((x) => pyCommand(x))).toEqual(c.commands);
      expect(registry.all().map((x) => x.name)).toEqual(c.visible);
      expect(pyDiagnostics(diagnostics)).toEqual(expectedDiagnostics(c.diagnostics));
      const resolved = Object.fromEntries(Object.keys(c.resolve).map((p) => [p, registry.get(p)?.name ?? null]));
      expect(resolved).toEqual(c.resolve);
    });
  }

  test("protected built-ins cannot be overridden; later sources win for new names", () => {
    const invalid = golden.cases.find((c: { id: string }) => c.id === "invalid");
    const messages = invalid.diagnostics.map((d: { error: string }) => d.error);
    expect(messages).toContain("cannot override protected built-in command: help");
    expect(messages).toContain("cannot override protected built-in command: clear");
    const override = golden.cases.find((c: { id: string }) => c.id === "override");
    const shared = override.commands.find((x: { name: string }) => x.name === "shared");
    expect(shared.source).toBe("workspace");
  });
});

describe("parseCommandFile on every fixture file, trusted and untrusted", () => {
  test("results and error messages match", () => {
    expect(golden.parse_cases.length).toBeGreaterThan(120);
    for (const c of golden.parse_cases) {
      const base = join(REPO_ROOT, c.base);
      const path = join(REPO_ROOT, c.path);
      const options = { source: c.trusted ? ("builtin" as const) : ("user" as const), allowTrustedTypes: c.trusted };
      if (c.error !== undefined) {
        let message: string | undefined;
        try {
          parseCommandFile(base, path, options);
        } catch (error) {
          expect(error).toBeInstanceOf(CommandError);
          message = (error as Error).message;
        }
        expect({ path: c.path, trusted: c.trusted, error: message && comparableError(message) }).toEqual({
          path: c.path,
          trusted: c.trusted,
          error: comparableError(c.error),
        });
      } else expect({ path: c.path, trusted: c.trusted, command: pyCommand(parseCommandFile(base, path, options)) }).toEqual({ path: c.path, trusted: c.trusted, command: c.command });
    }
  });
});

describe("dynamic trees", () => {
  for (const c of golden.dynamic) {
    test(c.id, () => {
      const root = mkdtempSync(join(tmpdir(), "dw-commands-"));
      temps.push(root);
      materialize(root, c.files);
      const { registry, diagnostics } = loadCommands({ builtinDir, userDir: join(root, "user") });
      expect(registry.all(true).map((x) => pyCommand(x, root))).toEqual(c.commands);
      expect(pyDiagnostics(diagnostics, root)).toEqual(expectedDiagnostics(c.diagnostics));
    });
  }

  test("invalid UTF-8 is a per-file diagnostic (Python crashes the whole load here)", () => {
    const root = mkdtempSync(join(tmpdir(), "dw-commands-"));
    temps.push(root);
    materialize(root, { "user/bad.md": { b64: Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a]).toString("base64") }, "user/ok.md": "---\ndescription: ok\n---\nok\n" });
    const { registry, diagnostics } = loadCommands({ builtinDir, userDir: join(root, "user") });
    expect(registry.get("ok")?.name).toBe("ok");
    expect(diagnostics[0]!.error).toStartWith("cannot read command file:");
  });
});

describe("slash parsing, rendering and dispatch", () => {
  test("parseSlashCommand", () => {
    for (const row of golden.slash) {
      const parsed = parseSlashCommand(row.input);
      expect({ input: row.input, name: parsed.name, arguments: parsed.arguments, is_command: parsed.isCommand }).toEqual(row);
    }
  });

  const { registry } = loadCommands({ builtinDir, userDir: join(commandFixtures, "basic/user") });

  test("renderCommandPrompt", () => {
    const prompts = registry.all(true).filter((c) => c.type === "prompt");
    expect(golden.render.length).toBe(prompts.length * 9);
    for (const row of golden.render) {
      const command = registry.get(row.command)!;
      expect(renderCommandPrompt(command, row.arguments)).toBe(row.output);
    }
  });

  test("resolve / prepareAgentTurn errors and results", () => {
    for (const row of golden.resolve) {
      if (typeof row.result === "string") expect(resolveCommand(registry, row.name).name).toBe(row.result);
      else expect(() => resolveCommand(registry, row.name)).toThrow(row.result.error);
    }
    for (const row of golden.prepare) {
      if (!row.result.error) {
        const turn = prepareAgentTurn(registry, row.name, row.arguments);
        expect({ command: turn.command.name, arguments: turn.arguments, prompt: turn.prompt }).toEqual(row.result);
      } else {
        expect(() => prepareAgentTurn(registry, row.name, row.arguments)).toThrow(CommandDispatchError);
        expect(() => prepareAgentTurn(registry, row.name, row.arguments)).toThrow(row.result.error);
      }
    }
  });

  test("dispatchCommand calls handlers by handler key", async () => {
    const handlers = {
      "client:help": (args: string, ctx: unknown) => `help[${args}|${ctx}]`,
      "server:compact": async (args: string, ctx: unknown) => ({ compacted: args, ctx }),
    };
    for (const row of golden.dispatch) {
      if (row.result.error) {
        await expect(dispatchCommand(registry, handlers, row.name, row.arguments, row.context)).rejects.toThrow(row.result.error);
      } else {
        const result = await dispatchCommand(registry, handlers, row.name, row.arguments, row.context);
        const value = result.value === undefined ? null : result.value;
        expect({ command: result.command.name, arguments: result.arguments, prompt: result.prompt, value }).toEqual(row.result);
      }
    }
  });
});

describe("availability and registry", () => {
  const builtins = builtinCommands(builtinDir);

  test("evaluateCommandAvailability and public dict with availability", () => {
    expect(golden.availability.length).toBe(17 * 7);
    for (const row of golden.availability) {
      const command = builtins.find((c) => c.name === row.command)!;
      const context: CommandAvailabilityContext | null =
        row.context === null
          ? null
          : { historyLength: row.context.history_length, modelAvailable: row.context.model_available, workspaceMounted: row.context.workspace_mounted };
      const availability = evaluateCommandAvailability(command, context);
      expect({ available: availability.available, code: availability.code, reason: availability.reason }).toEqual({ available: row.available, code: row.code, reason: row.reason });
      expect(pyPublic(command, availability)).toEqual(row.public);
    }
  });

  test("a frozen registry is immutable", () => {
    const frozen = new CommandRegistry([builtins[0]!]).freeze();
    expect(() => frozen.register(builtins[1]!)).toThrow(golden.frozen_error);
  });

  test("alias / name conflicts are rejected at registration", () => {
    const registry = new CommandRegistry([builtins.find((c) => c.name === "help")!]);
    expect(() => registry.register({ ...builtins.find((c) => c.name === "status")!, name: "h" })).toThrow("command name conflicts with existing name/alias: h");
    expect(() => registry.register({ ...builtins.find((c) => c.name === "status")!, aliases: ["?"] })).toThrow("command alias conflicts with existing name/alias: ?");
  });
});
