import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelRun,
  continueRun,
  fetchRun,
  fetchRuns,
  fetchWorkspaces,
  startRun,
  switchWorkspace,
  useEventStream,
  type AttachedImage,
  type ReportData,
  type RunPayload,
  type RunSummary,
  type TaskData,
} from "./api";
import { Composer, type ComposerMode } from "./components/Composer";
import { EventStream } from "./components/EventStream";
import { StatusBadge } from "./components/StatusBadge";
import { TaskSection, anchorId } from "./components/TaskSection";
import { TaskSidebar } from "./components/TaskSidebar";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { ContradictedIcon, ReportIcon, TaskIcon } from "./icons";

/** 这几种事件意味着"文档变了",值得重新拉一次。其余事件只用于实时态。 */
const DOC_CHANGING = new Set(["plan_done", "task_verdict", "run_done", "task_skipped"]);

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<"report" | "task">("report");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string>("");
  const [knownWorkspaces, setKnownWorkspaces] = useState<string[]>([]);
  const [vision, setVision] = useState(false);
  const [mode, setMode] = useState<ComposerMode>("new");

  const { events, live } = useEventStream(runId);
  const lastSeq = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const [{ runs: list, workspace: dir, vision: canSee }, spaces] = await Promise.all([
        fetchRuns(),
        fetchWorkspaces(),
      ]);
      setRuns(list);
      setWorkspace(dir);
      setVision(canSee);
      setKnownWorkspaces(spaces.known);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** 换工作区 = 换一整套运行。当前选中的运行必须一起清掉,它不属于新工作区。 */
  const changeWorkspace = useCallback(
    async (path: string): Promise<void> => {
      const spaces = await switchWorkspace(path);
      setWorkspace(spaces.current);
      setKnownWorkspaces(spaces.known);
      setRunId(null);
      setActive(null);
      lastSeq.current = 0;
      await refreshRuns();
    },
    [refreshRuns],
  );

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

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
        setActive((current) => current ?? next.tasks[0]?.doc?.data?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (runId === null || events.length === 0) return;
    const fresh = events.filter((event) => event.seq > lastSeq.current);
    if (fresh.length === 0) return;

    const shouldRefetch = fresh.some((event) => DOC_CHANGING.has(event.kind));
    lastSeq.current = events[events.length - 1]?.seq ?? 0;
    if (!shouldRefetch) return;

    void fetchRun(runId).then((next) => {
      setPayload(next);
      setActive((current) => current ?? next.tasks[0]?.doc?.data?.id ?? null);
    });
    void refreshRuns();
  }, [events, runId, refreshRuns]);

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

  const statusOfTask = useCallback(
    (taskId: string): string => {
      const settled = reportsForTask(taskId)?.status;
      if (settled !== undefined) return settled;
      if (events.some((event) => event.task === taskId && event.kind === "task_start")) return "running";
      return "pending";
    },
    [events, reportsForTask],
  );

  /* 滚动到某一节 —— 侧栏点击走这里 */
  const jumpTo = useCallback((taskId: string): void => {
    const node = document.getElementById(anchorId(taskId));
    if (node === null) return;
    setActive(taskId);
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /**
   * 反过来:滚到哪儿,侧栏就高亮哪儿。
   *
   * 只看每节顶部有没有进入视口上方 25% 那一条带 ——
   * 比起算可见面积,这个在长文档里更稳,也不会因为两节同时露出来而跳来跳去。
   */
  useEffect(() => {
    const root = contentRef.current;
    if (root === null || tasks.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = hit?.target.getAttribute("data-task");
        if (id !== null && id !== undefined) setActive(id);
      },
      { root, rootMargin: "0px 0px -75% 0px", threshold: 0 },
    );

    for (const task of tasks) {
      const node = document.getElementById(anchorId(task.id));
      if (node !== null) observer.observe(node);
    }

    return () => observer.disconnect();
  }, [tasks, view]);

  /**
   * 选中某次运行后,默认就是"接着说"。
   *
   * 用户的预期是延续 —— 上一句刚说完,下一句自然是在同一件事上往下走,
   * 而不是换个人从零接手。想另起一次,输入框上方有开关。
   */
  useEffect(() => {
    setMode(runId === null ? "new" : "continue");
  }, [runId]);

  const start = async (goal: string, images: AttachedImage[]): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "continue" && runId !== null) {
        await continueRun(runId, goal, images);
        await refreshRuns();
        return;
      }

      const { runId: created } = await startRun(goal, images);
      setActive(null);
      setRunId(created);
      await refreshRuns();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const current = runs.find((run) => run.id === runId);
  const isRunning = busy || current?.running === true;
  const stalled = current !== undefined && current.status === "running" && !isRunning;

  const tabClass = (on: boolean): string =>
    `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
      on ? "bg-slate-100 font-medium text-slate-900" : "text-muted hover:text-slate-900"
    }`;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">mastic</span>

        {/* 工作区是这一页的全部上下文:文件落在哪、运行列表里有谁,都由它决定 */}
        {workspace !== "" && (
          <WorkspacePicker current={workspace} known={knownWorkspaces} onSwitch={changeWorkspace} />
        )}

        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2">
          {current !== undefined && (
            <>
              <p className="truncate text-[12.5px] text-muted" title={current.goal}>
                {current.goal}
              </p>
              {/* run.md 说在跑、实际没进程在跑它 = 崩了或服务重启过。显示成"在跑"是骗人。 */}
              <StatusBadge
                status={stalled ? "interrupted" : current.status}
                {...(isRunning ? { running: true } : {})}
              />
              {current.error !== undefined && !isRunning && (
                <span className="truncate text-[11.5px] text-contradicted" title={current.error}>
                  {current.error}
                </span>
              )}
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
            setActive(null);
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

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_minmax(0,1fr)_minmax(300px,380px)]">
        <section className="flex min-h-0 flex-col overflow-y-auto border-r border-line">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <TaskIcon size={13} className="text-faint" />
            <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">任务</span>
            <span className="ml-auto font-mono text-[11px] text-faint">{tasks.length}</span>
          </div>
          <TaskSidebar tasks={tasks} statusOfTask={statusOfTask} active={active} onJump={jumpTo} />
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-2">
            <button className={tabClass(view === "report")} onClick={() => setView("report")}>
              <ReportIcon size={13} />
              交付报告
            </button>
            <button className={tabClass(view === "task")} onClick={() => setView("task")}>
              <TaskIcon size={13} />
              任务书
            </button>
            <span className="ml-auto text-[11.5px] text-faint">
              {active === null ? "" : `当前 ${active}`}
            </span>
          </div>

          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <TaskIcon size={22} className="text-faint" />
                <p className="text-[13px] text-faint">
                  {runId === null
                    ? "在下面写下你要做的事，然后回车。"
                    : "planner 交卷后，每个任务会在这里展开成一节。"}
                </p>
              </div>
            ) : (
              tasks.map((task) => (
                <TaskSection
                  key={task.id}
                  taskId={task.id}
                  task={payload?.tasks.find((entry) => entry.doc?.data?.id === task.id)}
                  report={payload?.reports.find((entry) => entry.doc?.data?.task === task.id)}
                  view={view}
                  runId={runId ?? ""}
                />
              ))
            )}
          </div>

          <Composer
            onSubmit={(goal, images) => void start(goal, images)}
            busy={isRunning}
            error={error}
            vision={vision}
            mode={mode}
            onMode={setMode}
            runId={runId}
          />
        </section>

        <section className="min-h-0 border-l border-line">
          <EventStream events={events} live={live} />
        </section>
      </main>
    </div>
  );
}
