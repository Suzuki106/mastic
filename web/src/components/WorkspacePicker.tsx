import { useEffect, useRef, useState } from "react";
import { WorkspaceIcon } from "../icons";

export interface WorkspacePickerProps {
  current: string;
  known: string[];
  onSwitch: (path: string) => Promise<void>;
}

const OTHER = "\u0000other";

/**
 * 工作区切换。
 *
 * 这不是可有可无的设置项 —— 一次运行只在它自己的工作区里说得通(报告里的
 * 相对路径、引用的文件全在那儿),所以"我想看那次运行"和"我得先把工作区
 * 切过去"是同一件事。
 */
export function WorkspacePicker({ current, known, onSwitch }: WorkspacePickerProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = async (): Promise<void> => {
    if (draft.trim() === "") {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSwitch(draft.trim());
      setEditing(false);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-running/50 bg-white px-2 py-1">
          <WorkspaceIcon size={12} className="text-faint" />
          <input
            ref={inputRef}
            value={draft}
            disabled={busy}
            placeholder="/path/to/project"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") {
                setEditing(false);
                setError(null);
              }
            }}
            className="w-[260px] border-0 bg-transparent font-mono text-[11.5px] text-slate-800 outline-none placeholder:text-faint"
          />
        </span>
        {error !== null && <span className="text-[11px] text-contradicted">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1">
      <WorkspaceIcon size={12} className="text-faint" />
      <select
        value={known.includes(current) ? current : OTHER}
        onChange={(event) => {
          if (event.target.value === OTHER) {
            setDraft("");
            setEditing(true);
            return;
          }
          void onSwitch(event.target.value);
        }}
        title={`agent 在这个目录里读写文件:${current}`}
        className="max-w-[280px] cursor-pointer border-0 bg-transparent font-mono text-[11.5px] text-muted outline-none"
      >
        {known.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
        <option value={OTHER}>＋ 其他路径…</option>
      </select>
    </span>
  );
}
