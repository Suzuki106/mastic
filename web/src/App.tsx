import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelRun,
  fetchRun,
  fetchRuns,
  startRun,
  useEventStream,
  type ReportData,
  type RunPayload,
  type RunSummary,
  type TaskData,
} from "./api";
import { Composer } from "./components/Composer";
import { DocumentView } from "./components/DocumentView";
import { EventStream } from "./components/EventStream";
import { StatusBadge } from "./components/StatusBadge";
import { TaskGraph } from "./components/TaskGraph";
import { ContradictedIcon, TaskIcon } from "./icons";

/** 这几种事件意味着"文档变了",值得重新拉一次。其余事件只用于实时态。 */
const DOC_CHANGING = new Set(["plan_done", "task_verdict", "run_done", "task_skipped"]);

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"report" | "task">("report");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { events, live } = useEventStream(runId);
  const lastSeq = useRef(0);

  /* 运行列表 —— 只在挂载时和一次运行结束时拉 */
  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const { runs: list } = await fetchRuns();
      setRuns(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  /* 选中的运行一变,拉它的文档并重置进度指针 */
  useEffect(() => {
    lastSeq.current = 0;
    if (runId === null) {
      setPayload(null);
      return;
    }

    let cancelled = false;
    void fetchRun(runId)
      .then((next) => {
        if (cancelled) return;
        setPayload(next);
        setSelected((current) => current ?? next.tasks[0]?.doc?.data?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  /* 事件流:只有"文档变了"的事件才重新拉文档,其余靠本地推导 */
  useEffect(() => {
    if (runId === null || events.length === 0) return;
    const fresh = events.filter((event) => event.seq > lastSeq.current);
    if (fresh.length === 0) return;

    const shouldRefetch = fresh.some((event) => DOC_CHANGING.has(event.kind));
    lastSeq.current = events[events.length - 1]?.seq ?? 0;

    if (!shouldRefetch) return;
    void fetchRun(runId).then((next) => {
      setPayload(next);
      // 新出现的任务自动选中第一个,省得每次跑完还要手点
      setSelected((current) => current ?? next.tasks[0]?.doc?.data?.id ?? null);
    });
    void refreshRuns();
  }, [events, runId, refreshRuns]);

  /* 运行结束后把 busy 收掉 */
  useEffect(() => {
    if (events.some((event) => event.kind === "run_done")) setBusy(false);
  }, [events]);

  const tasks: TaskData[] = useMemo(
    () => (payload?.tasks ?? []).flatMap((entry) => (entry.doc?.data ? [entry.doc.data] : [])),
    [payload],
  );

  const reportsForTask = useCallback(
    (taskId: string): ReportData | undefined =>
      (payload?.reports ?? []).find((entry) => entry.doc?.data?.task === taskId)?.doc?.data ?? undefined,
    [payload],
  );

  /**
   * 任务状态:以报告里的裁定为准;还没裁定的,就从事件流里推 ——
   * 于是"正在跑"是实时亮起来的,不用等下一次拉文档。
   */
  const statusOfTask = useCallback(
    (taskId: string): string => {
      const settled = reportsForTask(taskId)?.status;
      if (settled !== undefined) return settled;
      if (events.some((event) => event.task === taskId && event.kind === "task_start")) return "running";
      return "pending";
    },
    [events, reportsForTask],
  );

  const start = async (goal: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const { runId: created } = await startRun(goal);
      setSelected(null);
      setRunId(created);
      await refreshRuns();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const current = runs.find((run) => run.id === runId);
  const isRunning = busy || current?.running === true;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">mastic</span>
        <span className="text-[12px] text-faint">文档驱动的多 agent</span>

        <div className="ml-4 flex min-w-0 flex-1 items-center gap-2">
          {current !== undefined && (
            <>
              <p className="truncate text-[12.5px] text-muted" title={current.goal}>
                {current.goal}
              </p>
              <StatusBadge status={current.status} {...(isRunning ? { running: true } : {})} />
            </>
          )}
        </div>

        {isRunning && runId !== null && (
          <button
            onClick={() => void cancelRun(runId)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-contradicted/40 hover:text-contradicted"
          >
            <ContradictedIcon size={12} />
            取消
          </button>
        )}

        <select
          value={runId ?? ""}
          onChange={(event) => {
            setSelected(null);
            setRunId(event.target.value === "" ? null : event.target.value);
          }}
          className="max-w-[220px] shrink-0 rounded-lg border border-line-strong bg-white px-2 py-1 font-mono text-[11.5px] text-muted outline-none"
        >
          <option value="">（选择运行）</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.running ? "● " : ""}
              {run.goal.slice(0, 28) || run.id}
            </option>
          ))}
        </select>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(300px,380px)]">
        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <TaskIcon size={13} className="text-faint" />
            <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">任务树</span>
            <span className="ml-auto font-mono text-[11px] text-faint">{tasks.length}</span>
          </div>
          <div className="min-h-0 flex-1">
            <TaskGraph tasks={tasks} statusOfTask={statusOfTask} selected={selected} onSelect={setSelected} />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            {selected === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <TaskIcon size={22} className="text-faint" />
                <p className="text-[13px] text-faint">
                  {runId === null
                    ? "在下面写下你要做的事，然后回车。"
                    : "左边点一个任务，这里会显示它的任务书和交付报告。"}
                </p>
              </div>
            ) : (
              <DocumentView
                task={payload?.tasks.find((entry) => entry.doc?.data?.id === selected)}
                report={payload?.reports.find((entry) => entry.doc?.data?.task === selected)}
                view={view}
                onView={setView}
              />
            )}
          </div>
          <Composer onSubmit={(goal) => void start(goal)} busy={isRunning} error={error} />
        </section>

        <section className="min-h-0 border-l border-line">
          <EventStream events={events} live={live} />
        </section>
      </main>
    </div>
  );
}
