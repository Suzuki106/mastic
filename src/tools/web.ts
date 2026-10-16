import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { appendProvenance, readProvenance } from "../provenance.ts";
import { resolveInside } from "../paths.ts";
import type { Tool, ToolContext } from "./index.ts";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
/** 抓下来的东西的上限。数据集再大也不该整个塞进一次抓取。 */
const MAX_FETCH_BYTES = 32 * 1024 * 1024;

function apiKey(): string | undefined {
  // 用户把 key 放在 ~/.zshenv 里,叫 CYPHER_TAVILY_API_KEY;也认通用的名字
  return process.env.CYPHER_TAVILY_API_KEY ?? process.env.TAVILY_API_KEY;
}

/** 从 URL 里取一个能当文件名的短名,取不到就用序号。 */
function slugOf(url: string, index: number): string {
  try {
    const path = new URL(url).pathname;
    const name = basename(path);
    if (name !== "" && /^[\w.-]{1,60}$/.test(name)) return `${index}-${name}`;
  } catch {
    // URL 畸形,走兜底
  }
  return `${index}-download`;
}

const webSearchTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "联网搜索,用来**找数据来源**。返回标题、URL 和摘要。找到来源之后用 fetch_url 把数据抓下来 —— " +
        "搜索本身不产生数据,抓下来那份才算。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词。" },
          max_results: { type: "number", description: "返回几条,默认 5。" },
        },
        required: ["query"],
      },
    },
  },

  async run(args, ctx) {
    const query = args.query;
    if (typeof query !== "string" || query.trim() === "") throw new Error("`query` 必须是非空字符串");

    const key = apiKey();
    if (key === undefined) {
      throw new Error("没有搜到 Tavily 的 key。设 CYPHER_TAVILY_API_KEY(或 TAVILY_API_KEY)之后重试。");
    }

    const rawMax = args.max_results;
    const max = typeof rawMax === "number" && rawMax > 0 ? Math.min(Math.floor(rawMax), 10) : 5;

    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: max, search_depth: "basic" }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`搜索失败:HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    const results = payload.results ?? [];

    // 搜索是"发现",不是数据 —— 记一条它做过什么(不是实验输入,但让整次运行的
    // 来路可查:后来的人能看到它是怎么找到那份数据的)
    const saved = await appendProvenance(join(ctx.runRoot, "provenance.jsonl"), {
      kind: "search",
      query,
      resultCount: results.length,
    });

    if (results.length === 0) return `[溯源 #${saved.seq}] 没有搜到结果。换个说法再试。`;

    return (
      `[溯源 #${saved.seq}] 搜到 ${results.length} 条:\n\n` +
      results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title ?? "(无标题)"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
        )
        .join("\n\n") +
      `\n\n要拿哪一份,用 fetch_url 抓它。`
    );
  },
};

const fetchUrlTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "把一个 URL 的内容抓下来存进本次运行的 fetched/,并在溯源链上留一条带 sha256 的记录。" +
        "**实验用的数据必须是这样来的** —— 自己 write_file 写出来的数据没有来源,不能当实验输入。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓的地址。" },
          name: { type: "string", description: "可选:存盘时想用的文件名。" },
        },
        required: ["url"],
      },
    },
  },

  async run(args, ctx) {
    const url = args.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new Error("`url` 必须是 http(s) 地址");
    }

    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "mastic/0.1 (+data provenance)" },
      signal: AbortSignal.timeout(60_000),
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`抓下来 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB,超过上限`);
    }

    const index = (await readProvenance(join(ctx.runRoot, "provenance.jsonl"))).filter(
      (e) => e.kind === "fetch",
    ).length;

    const wanted = typeof args.name === "string" && /^[\w.-]{1,60}$/.test(args.name) ? args.name : undefined;
    const relative = join("fetched", wanted ?? slugOf(response.url, index + 1));
    const target = resolveInside(ctx.runRoot, relative);

    await mkdir(join(ctx.runRoot, "fetched"), { recursive: true });
    await writeFile(target, buffer);

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const saved = await appendProvenance(join(ctx.runRoot, "provenance.jsonl"), {
      kind: "fetch",
      url,
      finalUrl: response.url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      sha256,
      bytes: buffer.byteLength,
      path: relative,
    });

    const redirectNote = response.url === url ? "" : `\n  重定向到 ${response.url}`;
    const preview = buffer.subarray(0, 500).toString("utf8").replace(/\s+/g, " ");

    return (
      `[溯源 #${saved.seq}] 已抓取\n` +
      `  ${relative}\n` +
      `  状态 ${response.status}  ${response.headers.get("content-type") ?? ""}\n` +
      `  ${buffer.byteLength} 字节  sha256 ${sha256.slice(0, 16)}…${redirectNote}\n` +
      `--- 开头 500 字节 ---\n${preview}`
    );
  },
};

export const webTools: readonly Tool[] = [webSearchTool, fetchUrlTool];

/** 扩展名 → 是不是数据文件。给后面的溯源检查用。 */
export const DATA_EXTENSIONS = [".csv", ".tsv", ".json", ".jsonl", ".parquet", ".xlsx", ".txt", ".zip", ".gz", ".npz", ".npy"];

export function looksLikeDataFile(path: string): boolean {
  return DATA_EXTENSIONS.includes(extname(path).toLowerCase());
}
