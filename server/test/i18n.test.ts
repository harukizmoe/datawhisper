import { afterEach, describe, expect, test } from "bun:test";
import { INVALID_PARAMS } from "../src/ipc/errors.ts";
import { createMethods, mapSettingsError } from "../src/ipc/methods.ts";
import { isLang, language, say, setLanguage } from "../src/i18n.ts";
import { memoryServer } from "./support/rpc.ts";

afterEach(() => setLanguage("en"));

describe("界面语言", () => {
  test("默认英文；切到中文后 say 取中文，切回后恢复", () => {
    expect(language()).toBe("en");
    expect(say("hello", "你好")).toBe("hello");
    setLanguage("zh");
    expect(say("hello", "你好")).toBe("你好");
    setLanguage("en");
    expect(say("hello", "你好")).toBe("hello");
  });

  test("只认 en 与 zh", () => {
    expect(isLang("en")).toBe(true);
    expect(isLang("zh")).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  test("app.setLanguage 切换服务语言，非法取值被拒绝且不改语言", async () => {
    // 这个方法不碰 harness 等依赖：只取方法表里的这一项。
    const methods = createMethods({} as Parameters<typeof createMethods>[0]);
    const server = memoryServer({ "app.setLanguage": methods["app.setLanguage"]! }, mapSettingsError);

    expect((await server.call("app.setLanguage", { lang: "zh" })).result).toEqual({ lang: "zh" });
    expect(language()).toBe("zh");

    const bad = await server.call("app.setLanguage", { lang: "fr" });
    expect(bad.error?.code).toBe(INVALID_PARAMS);
    expect(language()).toBe("zh");
  });
});
