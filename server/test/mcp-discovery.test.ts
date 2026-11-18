/**
 * 发现状态的纯逻辑：只在目录版本匹配时沿用旧名，版本变化就作废；名字去重并只留最近 5 个。
 * 这层不碰连接，连接与目录由 `McpCatalogReader` 提供。
 */
import { describe, expect, test } from "bun:test";
import { discoverMcpForTurn } from "../src/mcp/index.ts";
import type { McpCatalogEntry, McpCatalogReader } from "../src/tools/app/mcp.ts";

const echo: McpCatalogEntry = {
  name: "mcp__fake__echo",
  server: "fake",
  summary: "Echo a message back.",
  keywords: ["echo", "message"],
  schema_hash: "h-echo",
};
const add: McpCatalogEntry = {
  name: "mcp__fake__add",
  server: "fake",
  summary: "Add two integers.",
  keywords: ["add", "sum"],
  schema_hash: "h-add",
};
const extras: McpCatalogEntry[] = ["one", "two", "three", "four", "five"].map((name) => ({
  name: `mcp__fake__${name}`,
  server: "fake",
  summary: `Unrelated ${name} tool.`,
  keywords: [name],
  schema_hash: `h-${name}`,
}));

function reader(version: string, entries: readonly McpCatalogEntry[]): McpCatalogReader {
  return { read: () => ({ catalog: entries, version }) };
}

describe("MCP 发现状态", () => {
  test("首轮按消息检索，记录名字与目录版本", async () => {
    const state = await discoverMcpForTurn(reader("v1", [echo, add]), "echo a message");
    expect(state.version).toBe("v1");
    expect(state.names).toEqual(["mcp__fake__echo"]);
  });

  test("版本一致时，旧名即使本轮不再匹配也保留", async () => {
    const state = await discoverMcpForTurn(reader("v1", [echo, add]), "hello", {
      names: ["mcp__fake__add"],
      version: "v1",
    });
    expect(state.names).toEqual(["mcp__fake__add"]);
  });

  test("目录版本变化后旧名作废", async () => {
    const state = await discoverMcpForTurn(reader("v2", [echo, add]), "echo", {
      names: ["mcp__fake__add"],
      version: "v1",
    });
    expect(state.names).toEqual(["mcp__fake__echo"]);
  });

  test("合并后去重，缓冲只留最近 10 个", async () => {
    const previous = { names: extras.map((entry) => entry.name), version: "v1" };
    const state = await discoverMcpForTurn(reader("v1", [echo, ...extras]), "echo", previous);
    // 5 个旧名 + 1 个新名仍在缓冲内；去掉重复后按到达顺序排列。
    expect(state.names).toHaveLength(6);
    expect(state.names.at(-1)).toBe("mcp__fake__echo");

    const crowded = Array.from({ length: 10 }, (_, index) => `mcp__fake__old${index}`);
    const trimmed = await discoverMcpForTurn(reader("v1", [echo]), "echo", { names: crowded, version: "v1" });
    expect(trimmed.names).toHaveLength(10);
    expect(trimmed.names).not.toContain("mcp__fake__old0");
    expect(trimmed.names.at(-1)).toBe("mcp__fake__echo");
  });
});
