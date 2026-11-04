/**
 * 技能与命令的「目录视图」：只给界面列条目需要的字段，不把整份 SKILL.md / prompt
 * 文本塞进列表（那是打开详情时才需要的，列表里几百条会把 IPC 撑爆）。
 */
import { basename } from "node:path";
import { loadCommands, commandToPublic, type CommandDirs } from "../agent/commands.ts";
import { SkillLoader, type SkillDirs } from "../agent/skills.ts";

export type CatalogLibraryDeps = {
  skillDirs: SkillDirs;
  commandDirs: CommandDirs;
};

export class CatalogLibrary {
  readonly #deps: CatalogLibraryDeps;

  constructor(deps: CatalogLibraryDeps) {
    this.#deps = deps;
  }

  skills() {
    const loader = new SkillLoader(this.#deps.skillDirs);
    loader.loadAll();
    return {
      skills: loader.catalog().map((skill) => ({
        name: skill.name,
        displayName: skill.displayName || skill.name,
        description: skill.description,
        icon: skill.icon,
        source: skill.source,
        tags: [...skill.tags],
        allowedTools: [...skill.allowedTools],
        resourceCount: skill.resources.length,
        promptChars: skill.prompt.length,
      })),
      diagnostics: loader.diagnostics().map((item) => ({
        path: basename(item.path),
        source: item.source,
        error: item.error,
      })),
    };
  }

  commands() {
    const { registry, diagnostics } = loadCommands(this.#deps.commandDirs);
    return {
      commands: registry.all().map((command) => {
        const payload = commandToPublic(command);
        if (command.type === "prompt") {
          payload.promptChars = command.prompt.length;
          payload.promptTokensEstimate = Math.ceil(command.prompt.length / 3.5);
          payload.promptSizeWarning = command.prompt.length > 28_000;
        }
        return payload;
      }),
      diagnostics: diagnostics.map((item) => ({
        path: basename(item.path),
        source: item.source,
        error: item.error,
      })),
    };
  }
}
