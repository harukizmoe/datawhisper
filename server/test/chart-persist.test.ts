import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistChartResult, writeChart } from "../src/tools/compute/persist.ts";

/**
 * 图表落盘：compute 的图表 HTML 只存活于单次调用，必须由工具外壳写文件，界面才有东西可渲染。
 */
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-chart-persist-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("图表落盘", () => {
  test("按 compute 记录的 id 字段写文件", () => {
    const dir = tempDir();
    const path = writeChart(dir, { id: "abc123", html: "<html>chart</html>" });
    expect(path).toBe(join(dir, "abc123.html"));
    expect(readFileSync(path!, "utf8")).toBe("<html>chart</html>");
  });

  test("id 不合法或没有 HTML 时不写文件", () => {
    const dir = tempDir();
    expect(writeChart(dir, { id: "../escape", html: "x" })).toBeUndefined();
    expect(writeChart(dir, { id: "ok", html: "   " })).toBeUndefined();
    expect(writeChart(dir, { chart_id: "old_style", html: "<p>x</p>" })).toBe(join(dir, "old_style.html"));
  });

  test("details 里的 html 换成 path，其余字段原样保留", () => {
    const dir = tempDir();
    const result = persistChartResult(
      {
        output: [{ type: "text", text: "Chart generated" }],
        details: {
          tool: "generate_chart",
          charts: [{ id: "c1", html: "<html>big page</html>", title: "T", chart_type: "Bar_Chart" }],
          artifacts: [{ type: "chart", name: "T" }],
        },
      },
      dir,
    );
    const details = result.details as { charts: { path?: string; html?: string; title: string }[]; artifacts: unknown[] };
    expect(details.charts[0]!.path).toBe(join(dir, "c1.html"));
    expect(details.charts[0]!.html).toBeUndefined();
    expect(details.charts[0]!.title).toBe("T");
    expect(details.artifacts).toHaveLength(1);
    expect(readFileSync(join(dir, "c1.html"), "utf8")).toBe("<html>big page</html>");
  });

  test("没有 charts 的结果原样返回（同一个对象）", () => {
    const dir = tempDir();
    const result = { output: [], details: { tool: "get_schema" } };
    expect(persistChartResult(result, dir)).toBe(result);
  });
});
