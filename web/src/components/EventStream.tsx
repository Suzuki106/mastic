import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../api";
import { eventTone } from "../lib/status";

/**
 * 值得停下来看的事件。
 *
 * 其余的(工具调用、文件读写)是过程噪音:一次运行里它们占八九成,
 * 全按同样分量铺出来,裁定就被淹了。所以默认只显示这些,
 * 其余收在"全部"里 —— 想看细节时再放出来。
 */
const IMPORTANT = new Set(["run_start", "run_done", "plan_done", "task_verdict", "task_retry", "task_skipped"]);

const KIND_LABEL: Record<string, string> = {
  run_start: "开始",
  run_done: "结束",
  plan_done: "计划",
  task_start: "起",
  task_verdict: "裁定",
  task_retry: "重派",
  task_skipped: "跳过",
  task_step: "步骤",
};

function clockOf(at: string): string {
  return at.slice(11, 19);
}

/** 裁定事件里 "verified —— 理由" 那一段,状态单独着色更有信息量。 */
function splitVerdict(detail: string): { status: string; rest: string } | null {
  const at = detail.indexOf(" —— ");
  if (at === -1) return null;
  return { status: detail.slice(0, at), rest: detail.slice(at + 4) };
}

function Row({ event, expanded, onToggle }: { event: RunEvent; expanded: boolean; onToggle: () => void }) {
  const important = IMPORTANT.has(event.kind);
  const verdict = event.kind === "task_verdict" ? splitVerdict(event.detail) : null;
  const long = event.detail.length > 90;

  return (
    <li className="border-b border-line/60 last:border-b-0">
      <button
        onClick={onToggle}
        className={`grid w-full grid-cols-[52px_54px_1fr] items-baseline gap-2 px-3 py-[3px] text-left transition-colors hover:bg-slate-50 ${
          important ? "" : "opacity-55 hover:opacity-90"
        }`}
      >
        <span className="font-mono text-[10.5px] text-faint">{clockOf(event.at)}</span>
        <span className={`truncate font-mono text-[10.5px] ${important ? "text-running" : "text-faint"}`}>
          {event.task ?? "run"}
        </span>

        <span className={`min-w-0 text-[12px] leading-[1.5] ${eventTone(event.kind)}`}>
          {verdict === null ? (
            <span className={expanded ? "break-words whitespace-pre-wrap" : "block truncate"}>
              {event.detail}
            </span>
          ) : (
            <>
              <span className="font-medium">{verdict.status}</span>
              <span className="text-faint"> · {verdict.rest}</span>
            </>
          )}
        </span>
      </button>

      {/* 太长的那条收起来,点开才铺满 —— 一条工具输出不该把整屏占掉 */}
      {expanded && long && (
        <pre className="mx-3 mb-2 overflow-x-auto rounded-md bg-slate-50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-slate-600">
          {event.detail}
        </pre>
      )}
    </li>
  );
}

export interface EventStreamProps {
  events: RunEvent[];
  live: boolean;
}

export function EventStream({ events, live }: EventStreamProps) {
  const [onlyImportant, setOnlyImportant] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  const shown = useMemo(
    () => (onlyImportant ? events.filter((event) => IMPORTANT.has(event.kind)) : events),
    [events, onlyImportant],
  );
  const hidden = events.length - shown.length;

  // 用户往上翻的时候别把他拽回来 —— 只有本来就在底部才自动跟随
  useEffect(() => {
    const node = listRef.current;
    if (node === null) return;
    const onScroll = (): void => {
      stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  // useLayoutEffect:在绘制前把位置定好,不然会看到"先跳到上面再滑下来"
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node === null || !stickToBottom.current) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [shown.length]);

  const latest = events[events.length - 1];

  const toggle = (seq: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">事件流</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? "animate-breathe bg-verified" : "bg-line-strong"}`}
          title={live ? "实时" : "未连接"}
        />
        <button
          onClick={() => setOnlyImportant((current) => !current)}
          className={`ml-auto rounded-md px-2 py-0.5 text-[11px] transition-colors ${
            onlyImportant ? "bg-slate-100 text-slate-700" : "text-faint hover:text-slate-700"
          }`}
          title="工具调用、文件读写这类过程事件默认收起"
        >
          {onlyImportant ? `只看关键${hidden > 0 ? ` (${hidden})` : ""}` : `全部 ${events.length}`}
        </button>
      </div>

      {/* 钉一条"现在在干嘛",省得为了知道进度去盯滚动条 */}
      {latest !== undefined && latest.kind !== "run_done" && (
        <div className="shrink-0 border-b border-line bg-slate-50/70 px-3 py-1.5">
          <p className="truncate font-mono text-[11px] text-slate-600">
            <span className="text-running">{latest.task ?? "run"}</span>
            <span className="text-faint"> · {clockOf(latest.at)} · </span>
            {latest.detail}
          </p>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-faint">
          {events.length === 0 ? "还没有事件。" : `只有过程事件(${hidden} 条),点右上角「全部」看。`}
        </div>
      ) : (
        <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((event) => (
            <Row
              key={event.seq}
              event={event}
              expanded={expanded.has(event.seq)}
              onToggle={() => toggle(event.seq)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
