import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { AttachedImage } from "../api";
import { AddImageIcon, ArrowIcon, RemoveIcon, RunningIcon } from "../icons";

export interface ComposerProps {
  onSubmit: (goal: string, images: AttachedImage[]) => void;
  busy: boolean;
  error: string | null;
  /** 当前模型收不收图。不收就不显示入口 —— 点了必然失败的东西不该摆出来。 */
  vision: boolean;
}

/** 和后端保持一致,免得本地放行、发过去才被拒。 */
const MAX_IMAGES = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function toAttachment(file: File): Promise<AttachedImage | { error: string }> {
  if (!ACCEPTED.includes(file.type)) {
    return { error: `${file.name || "这张图"}:只支持 PNG / JPEG / WebP / GIF。` };
  }
  if (file.size > MAX_BYTES) {
    return { error: `${file.name || "这张图"}:${(file.size / 1024 / 1024).toFixed(1)}MB,超过 4MB。` };
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读不出这个文件"));
    reader.readAsDataURL(file);
  });

  return { name: file.name === "" ? "粘贴的图片" : file.name, dataUrl };
}

export function Composer({ onSubmit, busy, error, vision }: ComposerProps) {
  const [goal, setGoal] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 高度跟着内容长,最多 6 行 —— 需求往往一句话写不完
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [goal]);

  const addFiles = async (files: File[]): Promise<void> => {
    setLocalError(null);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setLocalError(`最多 ${MAX_IMAGES} 张图。`);
      return;
    }

    const accepted: AttachedImage[] = [];
    for (const file of files.slice(0, room)) {
      const result = await toAttachment(file);
      if ("error" in result) {
        setLocalError(result.error);
        continue;
      }
      accepted.push(result);
    }

    if (files.length > room) setLocalError(`最多 ${MAX_IMAGES} 张图,多出来的没加。`);
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
  };

  const submit = (): void => {
    const trimmed = goal.trim();
    if (trimmed === "" || busy) return;
    onSubmit(trimmed, images);
    setGoal("");
    setImages([]);
    setLocalError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 有图没字也拦一下 —— 光发一张图,planner 不知道要干嘛
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // 截图直接粘贴是这个功能最常用的入口,不能少
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void addFiles(files);
  };

  const shown = localError ?? error;

  return (
    <div className="border-t border-line bg-white px-5 py-3">
      {shown !== null && (
        <p className="mb-2 rounded-lg border border-contradicted/30 bg-contradicted/5 px-3 py-2 text-[12.5px] text-contradicted">
          {shown}
        </p>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border bg-white px-3 py-2 transition-colors ${
          dragging ? "border-running bg-running/5" : "border-line-strong focus-within:border-running/60"
        }`}
      >
        {images.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <li key={index} className="group relative">
                <img
                  src={image.dataUrl}
                  alt={image.name}
                  title={image.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
                  title="移除"
                  className="absolute -top-1.5 -right-1.5 rounded-full border border-line bg-white p-0.5 text-faint shadow-sm transition-colors hover:border-contradicted/40 hover:text-contradicted"
                >
                  <RemoveIcon size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          {vision && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED.join(",")}
                multiple
                hidden
                onChange={(event) => {
                  void addFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                title="加图片(也可以直接拖进来或粘贴截图)"
                className="mb-0.5 shrink-0 rounded-lg border border-line px-2 py-1.5 text-faint transition-colors hover:border-line-strong hover:text-slate-700 disabled:opacity-40"
              >
                <AddImageIcon size={14} />
              </button>
            </>
          )}

          <textarea
            ref={areaRef}
            rows={1}
            value={goal}
            disabled={busy}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
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
      </div>

      <p className="mt-1.5 text-[11px] text-faint">
        {vision
          ? "可以带图:选择文件、拖进来、或直接粘贴截图,最多 4 张。"
          : "当前模型不收图(MASTIC_VISION=0)。"}
      </p>
    </div>
  );
}
