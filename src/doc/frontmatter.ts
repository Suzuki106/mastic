import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** 文档不合规时抛这个 —— 消息是写给模型看的,它会拿着这句去改。 */
export class DocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocError";
  }
}

const FENCED = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * 模型习惯把整篇文档裹在 ``` 里交回来。
 * 不剥掉的话第一行就是围栏而不是 `---`,会被误判成"没有 frontmatter"。
 */
export function stripFence(raw: string): string {
  const text = raw.trim();
  return FENCED.exec(text)?.[1]?.trim() ?? text;
}

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
}

/**
 * 拆出 frontmatter 与正文。
 *
 * 收尾的 `---` 必须独占一行 —— 正文里出现 `---`(Markdown 分隔线)很常见,
 * 所以只认"整行就是 ---"的那种,不做子串匹配。
 */
export function parseDoc(raw: string): ParsedDoc {
  const lines = stripFence(raw).split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    throw new DocError("文档第一行必须是 `---`,frontmatter 不能省。");
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new DocError("frontmatter 没有收尾的 `---`。");
  }

  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocError(`frontmatter 不是合法 YAML:${detail}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DocError("frontmatter 必须是一组 `key: value`。");
  }

  return {
    data: data as Record<string, unknown>,
    body: lines.slice(end + 1).join("\n").trim(),
  };
}

/**
 * 反向拼回文档。
 *
 * 解析出来的对象一律经这里重新落盘,而不是把模型给的原文直接写文件 ——
 * 这样磁盘上的格式由我们说了算,前端不必迁就模型的排版习惯。
 */
export function serialiseDoc(data: Record<string, unknown>, body: string): string {
  // lineWidth: 0 关掉折行 —— 折过的 YAML 人读起来很难受
  const yamlText = stringifyYaml(data, { lineWidth: 0 });
  return `---\n${yamlText}---\n\n${body.trim()}\n`;
}
