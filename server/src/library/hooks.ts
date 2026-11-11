/**
 * 用户自定义 Hook 的存取（旧 `data/hooks_store.py` + `api/hooks.py`）。
 *
 * 存储形状与校验规则完全复用 `agent/hooks/loader.ts` 的 `loadSettings` /
 * `serializeSettings`：写出去的文件就是旧 `config/hooks.json`，agent 侧读它时不需要迁移。
 * 校验失败按参数不合法（-32602）返回，错误文案来自 loader，界面可直接展示。
 */
import { DISPATCHED_EVENTS } from "../agent/hooks/events.ts";
import { HookConfigError, defaultSettings, loadSettings, serializeSettings } from "../agent/hooks/loader.ts";
import type { HookSettings } from "../agent/hooks/models.ts";
import { invalidParams } from "../ipc/errors.ts";
import { readJson, writeJson } from "./files.ts";

export type HooksLibraryDeps = {
  path: string;
};

function summary(settings: HookSettings) {
  const hooks = settings.hooks.map((hook) => ({
    id: hook.id,
    name: hook.name,
    enabled: hook.enabled,
    event: hook.event,
    actionType: hook.action.type,
    condition: hook.condition,
    async: hook.asyncExec,
    once: hook.once,
    onceScope: hook.onceScope,
    reject: hook.reject,
    eventDispatched: DISPATCHED_EVENTS[hook.event] === true,
    internalEndpoint: hook.internalEndpoint,
  }));
  const userHooks = hooks.filter((hook) => hook.enabled && !hook.internalEndpoint);
  const configuredUserHooks = hooks.filter((hook) => !hook.internalEndpoint);
  const runnable = userHooks.filter((hook) => hook.eventDispatched);
  return {
    hooks,
    runtime: {
      enabled: settings.enabled,
      enabledCount: userHooks.length,
      runnableCount: settings.enabled ? runnable.length : 0,
      pendingCount: userHooks.length - runnable.length,
      configuredCount: configuredUserHooks.length,
      internalEndpointCount: hooks.filter((hook) => hook.enabled && hook.internalEndpoint).length,
    },
  };
}

export class HooksLibrary {
  readonly #path: string;

  constructor(deps: HooksLibraryDeps) {
    this.#path = deps.path;
  }

  #readRaw(): unknown {
    try {
      const raw = readJson(this.#path);
      return raw === undefined ? defaultSettings() : raw;
    } catch (error) {
      if (error instanceof SyntaxError) throw new HookConfigError("hooks.json 不是合法 JSON");
      throw error;
    }
  }

  #validated(raw: unknown): HookSettings {
    try {
      return loadSettings(raw);
    } catch (error) {
      if (error instanceof HookConfigError) throw invalidParams(error.message);
      throw error;
    }
  }

  list() {
    let raw: unknown;
    try {
      raw = this.#readRaw();
    } catch (error) {
      if (!(error instanceof HookConfigError)) throw error;
      return { settings: defaultSettings(), hooks: [], error: error.message };
    }
    try {
      const settings = loadSettings(raw);
      const serialized = serializeSettings(settings);
      return { settings: serialized, ...summary(settings) };
    } catch (error) {
      if (!(error instanceof HookConfigError)) throw error;
      // 读取时保留坏配置给界面修，而不是把它当成空配置覆盖掉。
      return { settings: raw, hooks: [], error: error.message };
    }
  }

  save(params: Record<string, unknown>) {
    if (params.settings !== undefined) {
      const candidate = params.settings;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw invalidParams("'settings' must be an object");
      }
    }
    const raw =
      params.settings !== undefined
        ? params.settings
        : {
            enabled: params.enabled ?? true,
            allow_command_hooks: params.allowCommandHooks ?? params.allow_command_hooks ?? false,
            hooks: params.hooks ?? [],
          };
    const settings = this.#validated(raw);
    const serialized = serializeSettings(settings);
    writeJson(this.#path, serialized);
    return { settings: serialized, ...summary(settings) };
  }

  remove(id: string) {
    let raw: unknown;
    try {
      raw = this.#readRaw();
    } catch (error) {
      if (error instanceof HookConfigError) throw invalidParams(error.message);
      throw error;
    }
    const settings = this.#validated(raw);
    const remaining = settings.hooks.filter((hook) => hook.id !== id);
    const removed = remaining.length !== settings.hooks.length;
    if (removed) {
      const serialized = serializeSettings({ ...settings, hooks: remaining });
      writeJson(this.#path, serialized);
      return { removed, settings: serialized };
    }
    return { removed, settings: serializeSettings(settings) };
  }
}
