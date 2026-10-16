import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunPaths } from "./workspace.ts";

export type EventKind =
  | "run_start"
  | "thinking"
  | "assistant"
  | "plan_done"
  | "task_start"
  | "task_step"
  | "task_retry"
  | "task_verdict"
  | "task_skipped"
  | "run_done";

/**
 * 把工具循环里的事件类型映射到事件流的类型。
 *
 * 以前这里是一律写死 `task_step` 的,于是"正在请求模型"和一次普通的文件读取
 * 长得一模一样 —— 前端没法知道哪条是"还在进行中的模型调用",也就没法给它画
 * 个走动的秒表。用户看到的是一行不动的字,和卡住没有区别。
 */
export function eventKindOf(loopKind: string): EventKind {
  if (loopKind === "thinking") return "thinking";
  if (loopKind === "assistant") return "assistant";
  return "task_step";
}

/**
 * 工具循环的事件 → 事件流的事件。
 *
 * 收在这里是因为已经有**两处**转发点了,而两处都曾经把 kind 丢掉、一律写成
 * `task_step` —— 后果是"正在想什么"进了日志变成一条条残片,而"进行中的模型
 * 调用"在界面上认不出来。同一件事只有一个实现,才不会再漏第二遍。
 */
export function runEventOf(
  loopKind: string,
  task: string,
  detail: string,
): Omit<RunEvent, "seq" | "at" | "run"> {
  const kind = eventKindOf(loopKind);
  return {
    kind,
    task,
    detail,
    // 推理摘录是实时指标,不是记录 —— 不落盘
    ...(kind === "thinking" ? { transient: true } : {}),
  };
}

export interface RunEvent {
  /** 单调递增 —— 前端断线重连时靠它续上。 */
  seq: number;
  at: string;
  run: string;
  kind: EventKind;
  task?: string;
  detail: string;
  /**
   * 只推给正在看的界面,**不写进 events.jsonl**。
   *
   * 推理摘录就是这种东西:它是"此刻在想什么"的实时指标,不是这次运行的记录。
   * 落盘的话,日志里会塞满一条条残片 —— 每条都是截出来的,每条都得标个省略号,
   * 读起来像坏了。而事后翻记录的人要的是结论,不是当时的思考草稿。
   */
  transient?: boolean;
}

export interface EventBus {
  emit(event: Omit<RunEvent, "seq" | "at" | "run">): void;
  /** 返回退订函数。 */
  subscribe(listener: (event: RunEvent) => void): () => void;
  history(): RunEvent[];
}

/**
 * 只追加的事件流。
 *
 * 落盘给前端读、给事后复盘;内存里留一份给 SSE 订阅者。
 * 两处写的是同一串事件 —— 不存两份真相。
 */
export function createEventBus(paths: RunPaths, runId: string): EventBus {
  const events: RunEvent[] = [];
  const listeners = new Set<(event: RunEvent) => void>();

  // 串行化写入:并发 worker 同时 emit 时,appendFile 顺序错乱会让 jsonl 里
  // 出现半行。用一个 promise 链把写操作排成队。
  let writeChain: Promise<void> = Promise.resolve();

  return {
    emit(event) {
      const full: RunEvent = {
        seq: events.length + 1,
        at: new Date().toISOString(),
        run: runId,
        ...event,
      };

      events.push(full);
      for (const listener of listeners) listener(full);

      // 临时的到此为止:推给订阅者就够了,不落盘
      if (full.transient === true) return;

      writeChain = writeChain
        .then(async () => {
          await mkdir(dirname(paths.eventsFile), { recursive: true });
          await appendFile(paths.eventsFile, `${JSON.stringify(full)}\n`, "utf8");
        })
        .catch(() => {
          // 事件流写失败不该拖垮正在跑的任务 —— 它只是旁路记录
        });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    history() {
      return [...events];
    },
  };
}

/** 从磁盘读回一次运行的完整事件流 —— 重开前端时用。 */
export async function readEvents(paths: RunPaths): Promise<RunEvent[]> {
  try {
    const raw = await readFile(paths.eventsFile, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          return []; // 半行就跳过,不因为一行坏数据丢掉整段历史
        }
      });
  } catch {
    return [];
  }
}
