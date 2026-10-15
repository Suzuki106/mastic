import { useEffect, useLayoutEffect, useRef } from "react";
import type { RunEvent } from "../api";
import { eventTone } from "../lib/status";

function clockOf(at: string): string {
  return at.slice(11, 19);
}

export interface EventStreamProps {
  events: RunEvent[];
  live: boolean;
}

export function EventStream({ events, live }: EventStreamProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  // 用户往上翻的时候别把他拽回来 —— 只有本来就在底部才自动跟随
  useEffect(() => {
    const node = listRef.current;
    if (node === null) return;
    const onScroll = (): void => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      stickToBottom.current = distance < 40;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  // useLayoutEffect:在浏览器绘制前就把位置定好,不然会看到"先跳到上面再滑下来"
  useLayoutEffect(() => {
    const node = listRef.current;
    if (node === null || !stickToBottom.current) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">事件流</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? "animate-breathe bg-verified" : "bg-line-strong"}`}
          title={live ? "实时" : "未连接"}
        />
        <span className="ml-auto font-mono text-[11px] text-faint">{events.length}</span>
      </div>

      {events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-faint">
          还没有事件。
        </div>
      ) : (
        <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {events.map((event) => (
            // key 用 seq:同一条事件重连后不会重复插入,已渲染的那些原地不动 ——
            // 这是"不整屏刷新"的关键。
            <li
              key={event.seq}
              className="animate-rise mb-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-faint">{clockOf(event.at)}</span>
                <span className="font-mono text-[10.5px] font-medium text-running">
                  {event.task ?? "run"}
                </span>
              </div>
              <p className={`mt-0.5 text-[12px] leading-relaxed break-words ${eventTone(event.kind)}`}>
                {event.detail}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
