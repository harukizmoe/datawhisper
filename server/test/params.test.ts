import { describe, expect, test } from "bun:test";
import { checkParams, WORKSPACE_ID_RULE, workspaceIdParam } from "../src/ipc/params.ts";
import { INVALID_PARAMS } from "../src/ipc/errors.ts";

function code(fn: () => void): number | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

describe("checkParams", () => {
  test("必填缺失与类型不符都报 -32602，默认文案带键名", () => {
    expect(code(() => checkParams({}, { workspaceId: WORKSPACE_ID_RULE }))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ path: 1 }, { path: { type: "string" } }))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ n: 1.5 }, { n: { type: "integer" } }))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ ok: "yes" }, { ok: { type: "boolean" } }))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ list: {} }, { list: { type: "array" } }))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ map: [] }, { map: { type: "object" } }))).toBe(INVALID_PARAMS);
  });

  test("合法值放行；optional 允许缺省；自定义文案原样抛出", () => {
    expect(code(() => checkParams({}, { path: { type: "string", optional: true } }))).toBeUndefined();
    expect(code(() => checkParams({ path: "" }, { path: { type: "string", optional: true } }))).toBeUndefined();
    expect(code(() => checkParams({ workspaceId: "ws_0123456789abcdef" }, { workspaceId: WORKSPACE_ID_RULE }))).toBeUndefined();
    expect(code(() => checkParams({ path: "" }, { path: { type: "string", minLength: 1, message: "'path' must be a non-empty string" } }))).toBe(INVALID_PARAMS);
    try {
      checkParams({ workspaceId: "ws_x" }, { workspaceId: WORKSPACE_ID_RULE });
    } catch (error) {
      expect((error as Error).message).toBe("'workspaceId' must look like ws_<16 hex>");
    }
  });

  test("数组校验项式与项数上限", () => {
    const rule = { paths: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } } } as const;
    expect(code(() => checkParams({ paths: ["a"] }, rule))).toBeUndefined();
    expect(code(() => checkParams({ paths: [] }, rule))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ paths: ["a", "b", "c"] }, rule))).toBe(INVALID_PARAMS);
    expect(code(() => checkParams({ paths: ["a", 2] }, rule))).toBe(INVALID_PARAMS);
  });
});

describe("workspaceIdParam", () => {
  test("必填与形状两种错误各自一句，和旧实现一致", () => {
    expect(() => workspaceIdParam({})).toThrow("'workspaceId' must be a non-empty string");
    expect(() => workspaceIdParam({ workspaceId: "ws_x" })).toThrow("'workspaceId' must look like ws_<16 hex>");
    expect(workspaceIdParam({ workspaceId: "ws_0123456789abcdef" })).toBe("ws_0123456789abcdef");
  });

  test("数组元素不合法时报元素自己的文案", () => {
    const rule = { paths: { type: "array", items: { type: "string", message: "'paths' must contain only strings" } } } as const;
    expect(() => checkParams({ paths: ["a", 2] }, rule)).toThrow("'paths' must contain only strings");
  });
});
