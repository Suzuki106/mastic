import { useEffect, useRef, useState } from "react";

/* ── 服务端返回的形状 ─────────────────────────────────────── */

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  running: boolean;
  /** 死在半路时的原因。只有本进程起的运行才有。 */
  error?: string;
}

export interface DocEntry<T> {
  file: string;
  doc: { data: T | null; body: string } | null;
}

export type Acceptance =
  | { kind: "command"; run: string; label?: string; expect?: Record<string, unknown> }
  | { kind: "structural"; require: string[] }
  | { kind: "statement"; statement: string };

export interface TaskInput {
  kind: "file" | "dir" | "url" | "image";
  path?: string;
  url?: string;
  note?: string;
}

export interface TaskData {
  id: string;
  title?: string;
  goal?: string;
  depends_on?: string[];
  deliverable?: string;
  acceptance?: Acceptance[];
  constraints?: string[];
  inputs?: TaskInput[];
  budget?: { max_steps?: number };
}

export interface CheckReport {
  kind: "command" | "evidence" | "statement" | "lint";
  label: string;
  passed: boolean;
  /** 过了但有话要说 —— 典型是退出码对上了、输出不逐字节可复现。 */
  caveat?: boolean;
  detail: string;
}

export interface VerdictReport {
  decided_at: string;
  reasons: string[];
  checks: CheckReport[];
}

export interface Evidence {
  kind: "command" | "file" | "url";
  run?: string;
  cwd?: string;
  exit_code?: number;
  stdout_sha256?: string;
  stdout_bytes?: number;
  path?: string;
  sha256?: string;
  url?: string;
  note?: string;
}

export interface Claim {
  statement: string;
  evidence: Evidence[];
}

export interface ReportData {
  task: string;
  status: string;
  claims?: Claim[];
  files_changed?: { path: string; action: string }[];
  unresolved?: string[];
  blocked_reason?: string;
  verdict?: VerdictReport;
}

export interface RunData {
  id: string;
  goal: string;
  status: string;
  created_at?: string;
  finished_at?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface RunPayload {
  run: RunData | null;
  tasks: DocEntry<TaskData>[];
  reports: DocEntry<ReportData>[];
  running: boolean;
}

export interface RunEvent {
  seq: number;
  at: string;
  run: string;
  kind: string;
  task?: string;
  detail: string;
}

/* ── 请求 ─────────────────────────────────────────────────── */

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function fetchRuns(): Promise<{ runs: RunSummary[]; workspace: string; vision: boolean }> {
  return getJson("/api/runs");
}

export function fetchRun(runId: string): Promise<RunPayload> {
  return getJson(`/api/runs/${encodeURIComponent(runId)}`);
}

export interface AttachedImage {
  name: string;
  /** `data:image/png;base64,...` */
  dataUrl: string;
}

export async function startRun(goal: string, images: AttachedImage[] = []): Promise<{ runId: string }> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal, ...(images.length === 0 ? {} : { images }) }),
  });
  const payload = (await response.json()) as { runId?: string; error?: string };
  if (!response.ok || payload.runId === undefined) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return { runId: payload.runId };
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export interface WorkspaceList {
  current: string;
  known: string[];
}

export function fetchWorkspaces(): Promise<WorkspaceList> {
  return getJson("/api/workspaces");
}

export async function switchWorkspace(path: string): Promise<WorkspaceList> {
  const response = await fetch("/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return await fetchWorkspaces();
}

/* ── 事件流 ───────────────────────────────────────────────── */

/**
 * 订阅一次运行的事件流。
 *
 * 这里是"不刷新界面"的关键:新事件是**追加**到数组尾部的,
 * React 只重渲染多出来的那一条,已经画好的那些原地不动。
 */
export function useEventStream(runId: string | null): { events: RunEvent[]; live: boolean } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [live, setLive] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    setEvents([]);
    seen.current = new Set();
    if (runId === null) return;

    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);

    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      // 断线重连会重放整个文件,靠 seq 去重,免得同一条冒出来两次
      if (seen.current.has(event.seq)) return;
      seen.current.add(event.seq);
      setEvents((previous) => [...previous, event]);
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, [runId]);

  return { events, live };
}
