import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../api";
import { RunningIcon } from "../icons";
import { eventTone } from "../lib/status";

/**
 * 值得停下来看的事件。
 *
 * 用来**收窄**,不是用来默认隐藏 —— 一开始我把它当默认值,结果是:planner 想
 * 十分钟,期间全是过程事件,屏幕上就只剩一条 `run_start` 一动不动,
 * 看着像死了。一条事件现在只占一行,铺出来不挤,默认就全显示。
 */
const IMPORTANT = new Set(["run_start", "run_done", "plan_done", "task_verdict", "task_retry", "task_skipped"]);

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
          important ? "" : "opacity-60 hover:opacity-100"
        }`}
      >
        <span className="font-mono text-[10.5px] text-faint">{clockOf(event.at)}</span>
        <span className={`truncate font-mono text-[10.5px] ${important ? "text-running" : "text-faint"}`}>
          {event.task ?? "run"}
        </span>

        <span className={`min-w-0 text-[12px] leading-[1.5] ${eventTone(event.kind)}`}>
          {verdict === null ? (
            <span className={expanded ? "break-words whitespace-pre-wrap" : "block truncate"}>{event.detail}</span>
          ) : (
            <>
              <span className="font-medium">{verdict.status}</span>
              <span className="text-faint"> · {verdict.rest}</span>
            </>
          )}
        </span>
      </button>

      {expanded && long && (
        <pre className="mx-3 mb-2 overflow-x-auto rounded-md bg-slate-50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-slate-600">
          {event.detail}
        </pre>
      )}
    </li>
  );
}

/** 还在进行中的那次模型调用。秒表由界面自己走,不是靠往日志里灌记录。 */
function ThinkingRow({ event, elapsed }: { event: RunEvent; elapsed: number }) {
  const label = event.detail.startsWith("想完了") ? "想完了" : "正在思考";

  return (
    <li className="border-b border-line/60 bg-running/4 last:border-b-0">
      <div className="grid grid-cols-[52px_54px_1fr] items-baseline gap-2 px-3 py-[3px]">
        <span className="font-mono text-[10.5px] text-faint">{clockOf(event.at)}</span>
        <span className="truncate font-mono text-[10.5px] text-running">{event.task ?? "run"}</span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[1.5] text-running">
          <RunningIcon size={12} className="animate-spin shrink-0 self-center" />
          <span className="shrink-0 font-medium">{label}</span>
          <span className="font-mono text-[11px] tabular-nums text-running/70">{elapsed}s</span>
          <span className="truncate text-faint">{event.detail}</span>
        </span>
      </div>
    </li>
  );
}

export interface EventStreamProps {
  events: RunEvent[];
  live: boolean;
}

export function EventStream({ events, live }: EventStreamProps) {
  // 默认全显示 —— 过程事件才是"正在发生什么",而那是这个面板存在的理由
  const [onlyImportant, setOnlyImportant] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  const shown = useMemo(
    () => (onlyImportant ? events.filter((event) => IMPORTANT.has(event.kind)) : events),
    [events, onlyImportant],
  );
  const hidden = events.length - shown.length;

  const latest = events[events.length - 1];
  // "最后一条是 thinking" = 这一轮还没回来,秒表继续走
  const thinking = latest?.kind === "thinking" ? latest : undefined;
  const thinkingSeq = thinking?.seq;

  useEffect(() => {
    if (thinkingSeq === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [thinkingSeq]);

  useEffect(() => {
    const node = listRef.current;
    if (node === null) return;
    const onScroll = (): void => {
      const near = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      stickToBottom.current = near;
      setAtBottom(near);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  // useLayoutEffect:在绘制前把位置定好,不然会看到"先跳到上面再滑下来"
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node === null || !stickToBottom.current) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [shown.length, thinkingSeq]);

  const toggle = (seq: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const elapsed = thinking === undefined ? 0 : Math.max(0, Math.floor((now - new Date(thinking.at).getTime()) / 1000));

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
          title={onlyImportant ? "显示全部事件" : "只看裁定和跨任务的关键事件"}
        >
          {onlyImportant ? `只看关键${hidden > 0 ? ` (${hidden})` : ""}` : `全部 ${events.length}`}
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-faint">
          {events.length === 0 ? "还没有事件。" : `只有过程事件(${hidden} 条),点右上角「全部」看。`}
        </div>
      ) : (
        <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((event) =>
            event.seq === thinkingSeq ? (
              <ThinkingRow key={event.seq} event={event} elapsed={elapsed} />
            ) : (
              <Row
                key={event.seq}
                event={event}
                expanded={expanded.has(event.seq)}
                onToggle={() => toggle(event.seq)}
              />
            ),
          )}
        </ol>
      )}

      {/* 只有你翻上去看历史时才出现 —— 一直在底部的话它就只是重复最后一行,
          还容易被当成"第一张卡片一直在刷" */}
      {!atBottom && latest !== undefined && (
        <button
          onClick={() => {
            stickToBottom.current = true;
            setAtBottom(true);
            listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
          }}
          className="shrink-0 border-t border-line bg-slate-50 px-3 py-1.5 text-left transition-colors hover:bg-slate-100"
        >
          <span className="truncate font-mono text-[11px] text-slate-600">
            <span className="text-running">{latest.task ?? "run"}</span>
            <span className="text-faint"> · </span>
            {latest.detail}
          </span>
        </button>
      )}
    </div>
  );
}
