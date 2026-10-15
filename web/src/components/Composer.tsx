import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowIcon, RunningIcon } from "../icons";

export interface ComposerProps {
  onSubmit: (goal: string) => void;
  busy: boolean;
  error: string | null;
}

export function Composer({ onSubmit, busy, error }: ComposerProps) {
  const [goal, setGoal] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // 高度跟着内容长,最多 6 行 —— 需求往往一句话写不完
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [goal]);

  const submit = (): void => {
    const trimmed = goal.trim();
    if (trimmed === "" || busy) return;
    onSubmit(trimmed);
    setGoal("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line bg-white px-5 py-3">
      {error !== null && (
        <p className="mb-2 rounded-lg border border-contradicted/30 bg-contradicted/5 px-3 py-2 text-[12.5px] text-contradicted">
          {error}
        </p>
      )}

      <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 transition-colors focus-within:border-running/60">
        <textarea
          ref={areaRef}
          rows={1}
          value={goal}
          disabled={busy}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? "正在跑…" : "说清楚要做什么。Enter 开始,Shift+Enter 换行。"}
          className="max-h-[132px] flex-1 resize-none border-0 bg-transparent py-1 text-[13.5px] leading-relaxed text-slate-900 outline-none placeholder:text-faint disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={busy || goal.trim() === ""}
          className="mb-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-25"
        >
          {busy ? <RunningIcon size={13} className="animate-breathe" /> : <ArrowIcon size={13} />}
          {busy ? "在跑" : "开始"}
        </button>
      </div>

      <p className="mt-1.5 text-[11px] text-faint">
        开始后 planner 会先拆任务树,worker 逐个执行,verifier 逐条验收。全程在右边实时可见。
      </p>
    </div>
  );
}
