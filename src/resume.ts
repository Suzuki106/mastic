import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verify } from "./agent/verifier.ts";
import { work } from "./agent/worker.ts";
import type { Config } from "./config.ts";
import { parseTaskDoc, type TaskDoc } from "./doc/task.ts";
import { createEventBus } from "./events.ts";
import { readReport, writeReport, writeRunDoc, readRunDoc, runPaths, type RunPaths } from "./workspace.ts";

/** 每个任务最多回灌多少字符。和 orchestrator 保持一致。 */
const MAX_TOOL_OUTPUT = 30_000;

export interface ResumeOutcome {
  taskId: string;
  status: string;
  reasons: string[];
  failure?: string;
}

async function loadTasks(paths: RunPaths): Promise<TaskDoc[]> {
  let names: string[];
  try {
    names = (await readdir(paths.tasksDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }

  const tasks: TaskDoc[] = [];
  for (const name of names) {
    const { task } = parseTaskDoc(await readFile(join(paths.tasksDir, name), "utf8"));
    if (task !== undefined) tasks.push(task);
  }
  return tasks;
}

/**
 * 续跑一次已有的运行。
 *
 * 崩溃、被取消、或者只想重做其中某一个任务时用。它**不会**重新规划 ——
 * 任务书是现成的,直接把 worker 和 verifier 再跑一遍,报告覆盖写回去。
 *
 * 之所以需要这个:一次运行可能在最后一个任务上挂掉,而前面六个的成果都在。
 * 没有续跑,就只能整个重来 —— 那是把几十分钟的推理和已经验过的结论再烧一遍。
 */
export async function resumeRun(
  config: Config,
  workspace: string,
  runId: string,
  taskIds: string[] = [],
  onEvent?: (event: { kind: string; task?: string; detail: string }) => void,
): Promise<ResumeOutcome[]> {
  const paths = runPaths(workspace, runId);
  const bus = createEventBus(paths, runId);
  if (onEvent !== undefined) bus.subscribe(onEvent);

  const tasks = await loadTasks(paths);
  if (tasks.length === 0) throw new Error(`${runId} 里没有任务书,没法续跑。`);

  // 没指定就挑"还没有报告"的那些 —— 那正是上次没做完的
  let targets: TaskDoc[];
  if (taskIds.length > 0) {
    targets = tasks.filter((task) => taskIds.includes(task.id));
  } else {
    targets = [];
    for (const task of tasks) {
      if ((await readReport(paths, task.id)) === undefined) targets.push(task);
    }
  }

  if (targets.length === 0) {
    bus.emit({ kind: "run_done", detail: "没有需要补的任务" });
    return [];
  }

  const run = await readRunDoc(paths);
  bus.emit({ kind: "run_start", detail: `续跑 ${targets.map((task) => task.id).join("、")}` });

  const outcomes: ResumeOutcome[] = [];

  for (const task of targets) {
    bus.emit({ kind: "task_start", task: task.id, detail: "续跑" });

    const worked = await work({
      config,
      task,
      workspace,
      runRoot: paths.root,
      timeoutMs: config.commandTimeoutMs,
      maxOutputChars: MAX_TOOL_OUTPUT,
      onEvent: (event) =>
        bus.emit({ kind: event.kind === "thinking" ? "thinking" : "task_step", task: task.id, detail: event.detail }),
    });

    if (worked.report === undefined) {
      const failure = worked.failure ?? "worker 没有交卷";
      bus.emit({ kind: "task_verdict", task: task.id, detail: `没交卷 —— ${failure}` });
      outcomes.push({ taskId: task.id, status: "failed", reasons: [failure], failure });
      continue;
    }

    const { verdict, report } = await verify({
      config,
      task,
      report: worked.report,
      workspace,
      timeoutMs: config.commandTimeoutMs,
      onEvent: (detail) => bus.emit({ kind: "task_step", task: task.id, detail }),
    });

    await writeReport(paths, report);
    bus.emit({ kind: "task_verdict", task: task.id, detail: `${verdict.status} —— ${verdict.reasons[0] ?? ""}` });
    outcomes.push({ taskId: task.id, status: verdict.status, reasons: verdict.reasons });
  }

  const done = outcomes.every((outcome) => outcome.status === "verified" || outcome.status === "unverified");
  const finishedAt = new Date().toISOString();

  bus.emit({ kind: "run_done", detail: outcomes.map((o) => `${o.taskId} ${o.status}`).join(" · ") });

  await writeRunDoc(paths, {
    id: runId,
    goal: run?.goal ?? "",
    workspace,
    created_at: run?.created_at ?? finishedAt,
    finished_at: finishedAt,
    status: done ? "done" : "failed",
    ...(run?.usage === undefined ? {} : { usage: run.usage }),
  });

  return outcomes;
}
