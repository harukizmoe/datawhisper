/**
 * `browse_webpage`：有界读取公开 HTTP(S) 页面。
 *
 * 移植自 `agent/tools/web.py`：域名解析后拒绝本地/私网/保留地址，最多读
 * 768 000 字节，输出默认 12 000 字符；HTML 走无 DOM 的文本抽取。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errorResult, makeAppTool, okResult, type AppTool, type AppToolDeps } from "./types.ts";

const MAX_READ_BYTES = 768_000;

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function ipv6Private(address: string): boolean {
  const lowered = address.toLowerCase();
  if (lowered === "::" || lowered === "::1") return true;
  if (lowered.startsWith("::ffff:")) return ipv4Private(lowered.slice("::ffff:".length));
  return (
    lowered.startsWith("fc") ||
    lowered.startsWith("fd") ||
    /^fe[89ab]/.test(lowered) ||
    lowered.startsWith("ff")
  );
}

function rejectPrivateHost(host: string): void {
  const lowered = host.toLowerCase().replace(/\.$/, "");
  if (["localhost", "127.0.0.1", "::1"].includes(lowered) || lowered.endsWith(".localhost")) {
    throw new Error("local/private network URLs are not allowed");
  }
  if (isIP(lowered) !== 0 && (ipv4Private(lowered) || ipv6Private(lowered))) {
    throw new Error("local/private network URLs are not allowed");
  }
}

function validateUrl(url: string): URL {
  const raw = String(url ?? "").trim();
  if (!raw) throw new Error("url is required");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("only absolute http/https URLs are supported");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only absolute http/https URLs are supported");
  }
  if (!parsed.hostname) throw new Error("URL host is required");
  rejectPrivateHost(parsed.hostname);
  return parsed;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** 无 DOM 的页面正文抽取：只保留可见文本，块级标签换行。 */
export function extractPageText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").replace(/\s+/g, " ").trim() : "";
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<(script|style|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  body = body.replace(/<\/?(?:p|div|section|article|br|li|tr|h1|h2|h3)\b[^>]*>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  const lines: string[] = [];
  for (const raw of decodeEntities(body).split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  }
  return { title, text: lines.join("\n") };
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return match?.[1] ?? "utf-8";
}

export function createWebTools(deps: AppToolDeps): AppTool[] {
  const fetchImpl = deps.fetch ?? fetch;
  return [
    makeAppTool<{ url: string; max_chars?: number }>({
      name: "browse_webpage",
      description:
        "Read a public HTTP(S) webpage and return bounded text for configuration tasks. " +
        "Use this when the user sends a URL/link/API documentation/webhook documentation " +
        "and asks you to configure something from it. Local/private network URLs are blocked. " +
        "For Hooks auto-configuration, first call browse_webpage on the user's link, then " +
        "derive a minimal Hooks JSON config, then call configure_hooks.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute public http:// or https:// URL to read." },
          max_chars: {
            type: "integer",
            minimum: 1000,
            maximum: 30000,
            description: "Maximum readable characters to return. Default 12000.",
          },
        },
        required: ["url"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const parsed = validateUrl(args.url ?? "");
          const host = parsed.hostname;
          if (isIP(host) === 0) {
            let addresses: { address: string }[];
            try {
              addresses = await lookup(host, { all: true });
            } catch (error) {
              throw new Error(`cannot resolve URL host: ${host}`);
            }
            if (addresses.some(({ address }) => ipv4Private(address) || ipv6Private(address))) {
              throw new Error("local/private network URLs are not allowed");
            }
          }
          const maxChars = Math.max(1000, Math.min(Math.trunc(args.max_chars ?? 12_000) || 12_000, 30_000));
          const response = await fetchImpl(parsed.toString(), {
            headers: {
              "User-Agent": "BusinessAnalyticsAgent/1.0 (+hooks-auto-config)",
              Accept: "text/html,application/json,text/plain,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(20_000),
          });
          const contentType = response.headers.get("content-type") ?? "";
          const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, MAX_READ_BYTES);
          const text = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(buffer);
          let pageTitle: string;
          let content: string;
          if (contentType.toLowerCase().includes("json")) {
            try {
              content = JSON.stringify(JSON.parse(text), null, 2);
            } catch {
              content = text;
            }
            pageTitle = "JSON response";
          } else if (contentType.toLowerCase().includes("html") || text.slice(0, 500).toLowerCase().includes("<html")) {
            const extracted = extractPageText(text);
            pageTitle = extracted.title || parsed.toString();
            content = extracted.text;
          } else {
            pageTitle = parsed.toString();
            content = text;
          }
          content = content.trim();
          if (content.length > maxChars) {
            content = content.slice(0, maxChars).replace(/\s+$/, "") + "\n...[truncated]";
          }
          const output = [
            `URL: ${parsed.toString()}`,
            `HTTP status: ${response.status}`,
            `Content-Type: ${contentType || "unknown"}`,
            `Title: ${pageTitle}`,
            "",
            content || "(no readable text extracted)",
          ].join("\n");
          return okResult("browse_webpage", output, {
            tool: "browse_webpage",
            url: parsed.toString(),
            status: response.status,
            content_type: contentType,
            title: pageTitle,
            chars: content.length,
          });
        } catch (error) {
          return errorResult("browse_webpage", error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
}
