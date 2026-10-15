import type { ReactNode } from "react";

/**
 * 极简 Markdown → React 节点。
 *
 * 和后端那版手写渲染器的关键区别:这里**根本不生成 HTML 字符串**,
 * 也就不存在"忘了转义"这种可能。模型给的内容只会作为文本节点进入 DOM,
 * XSS 在结构上就不成立,不需要靠"记得先 escapeHtml"这种纪律。
 */

type Segment = { kind: "code"; text: string } | { kind: "text"; text: string };

/** 先把围栏代码块摘出来占位,免得块里的 # 和 * 被当成标题和强调。 */
function splitFences(source: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ kind: "text", text: source.slice(cursor, at) });
    segments.push({ kind: "code", text: match[1] ?? "" });
    cursor = at + match[0].length;
  }

  if (cursor < source.length) segments.push({ kind: "text", text: source.slice(cursor) });
  return segments;
}

/** 行内标记。返回的是 React 节点数组,不是字符串。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(text.slice(cursor, at));

    const token = match[0];
    index += 1;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-c${index}`} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12.5px] text-sky-700">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>,
      );
    }

    cursor = at + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderTextBlock(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: string[] = [];
  let line = 0;

  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(
      <ul key={`${key}-ul${out.length}`} className="my-2 list-disc space-y-1 pl-5">
        {list.map((item, index) => (
          <li key={index}>{inline(item, `${key}-li${index}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of text.split("\n")) {
    line += 1;

    const heading = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (heading) {
      flushList();
      const level = (heading[1] ?? "#").length;
      const sizes = ["text-base", "text-[15px]", "text-sm", "text-sm"];
      out.push(
        <p
          key={`${key}-h${line}`}
          className={`mt-4 mb-1.5 font-semibold text-slate-900 ${sizes[level - 1] ?? "text-sm"}`}
        >
          {inline(heading[2] ?? "", `${key}-h${line}`)}
        </p>,
      );
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (item) {
      list.push(item[1] ?? "");
      continue;
    }

    if (raw.trim() === "") {
      flushList();
      continue;
    }

    flushList();
    out.push(
      <p key={`${key}-p${line}`} className="my-1.5">
        {inline(raw, `${key}-p${line}`)}
      </p>,
    );
  }

  flushList();
  return out;
}

export function Markdown({ source }: { source: string }): ReactNode {
  const segments = splitFences(source);

  return (
    <div className="text-[13.5px] leading-relaxed text-slate-700">
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <pre
            key={index}
            className="my-2 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[12.5px] text-slate-700"
          >
            <code>{segment.text}</code>
          </pre>
        ) : (
          <div key={index}>{renderTextBlock(segment.text, `t${index}`)}</div>
        ),
      )}
    </div>
  );
}
