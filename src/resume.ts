import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { plan, type ExistingTask, type PlanImage } from "./agent/planner.ts";
import { verify } from "./agent/verifier.ts";
import { work } from "./agent/worker.ts";
import { saveImage, type IncomingImage } from "./attachments.ts";
import type { Config } from "./config.ts";
import { parseTaskDoc, type TaskDoc } from "./doc/task.ts";
import { createEventBus, runEventOf, type EventBus, type RunEvent } from "./events.ts";
import { loadExtensions, type Extensions } from "./extensions.ts";
import { allocateSteps } from "./orchestrator.ts";
import { discoveryTools } from "./tools/index.ts";
import {
  readReport,
  writeReport,
  writeRunDoc,
  writeTask,
  readRunDoc,
  runPaths,
  type RunPaths,
} from "./workspace.ts";

/** 每个任务最多回灌多少字符。和 orchestrator 保持一致。 */
const MAX_TOOL_OUTPUT = 30_000;

export interface ResumeOutcome {
  taskId: string;
  status: string;
  reasons: string[];
  failure?: string;
}

export interface ContinueResult {
  /** 这次追加进来的任务。 */
  planned: TaskDoc[];
  /** planner 认为现状已经满足,不用加任务。 */
  nothingToDo: boolean;
  outcomes: ResumeOutcome[];
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
  onEvent?: (event: RunEvent) => void,
  extensions?: Extensions,
): Promise<ResumeOutcome[]> {
  const paths = runPaths(workspace, runId);
  const bus = createEventBus(paths, runId);
  if (onEvent !== undefined) bus.subscribe(onEvent);

  const owns = extensions === undefined;
  const ext =
    extensions ??
    (await loadExtensions({
      config,
      workspace,
      onEvent: (detail) => bus.emit({ kind: "task_step", task: "run", detail }),
    }));

  try {
    return await resumeWith(config, workspace, runId, taskIds, paths, bus, ext);
  } finally {
    if (owns) ext.close();
  }
}

async function resumeWith(
  config: Config,
  workspace: string,
  runId: string,
  taskIds: string[],
  paths: RunPaths,
  bus: EventBus,
  extensions: Extensions,
): Promise<ResumeOutcome[]> {
  const tasks = await loadTasks(paths);
  if (tasks.length === 0) throw new Error(`${runId} 里没有任务书,没法续跑。`);

  // 没指定就挑"还没有报告"的那些 —— 那正是上次没做完的
  const outcomes: ResumeOutcome[] = [];

  // 现有裁定。依赖检查靠它 —— 追加进来的新任务很可能依赖某个旧任务,
  // 那个旧任务没做完的话,新任务现在跑没有意义。
  const settled = new Map<string, string>();
  for (const task of tasks) {
    const report = await readReport(paths, task.id);
    if (report !== undefined) settled.set(task.id, report.status);
  }

  const depsReady = (task: TaskDoc): boolean =>
    task.depends_on.every((dep) => {
      const status = settled.get(dep);
      return status === "verified" || status === "unverified";
    });

  const pending = tasks.filter((task) => !settled.has(task.id));
  const wanted = taskIds.length > 0 ? pending.filter((task) => taskIds.includes(task.id)) : pending;

  const targets: TaskDoc[] = [];
  for (const task of wanted) {
    if (depsReady(task)) {
      targets.push(task);
      continue;
    }
    const missing = task.depends_on.filter((dep) => {
      const status = settled.get(dep);
      return status !== "verified" && status !== "unverified";
    });
    const why = `依赖 ${missing.join("、")} 还没完成,先跳过。`;
    bus.emit({ kind: "task_skipped", task: task.id, detail: why });
    outcomes.push({ taskId: task.id, status: "skipped", reasons: [why] });
  }

  if (targets.length === 0) {
    bus.emit({ kind: "run_done", detail: "没有需要补的任务" });
    return outcomes;
  }

  const run = await readRunDoc(paths);
  bus.emit({ kind: "run_start", detail: `续跑 ${targets.map((task) => task.id).join("、")}` });

  // 和整次运行同一套分配:剩余预算 ÷ 还没做的任务数。
  // 绝不退回"每个任务一个固定数"——那又变成拍脑袋了。
  let remainingSteps = config.runBudgetSteps;

  for (const [index, task] of targets.entries()) {
    const maxSteps = allocateSteps(remainingSteps, targets.length - index, config.taskStepCeiling);
    bus.emit({ kind: "task_start", task: task.id, detail: "续跑" });

    const worked = await work({
      config,
      task,
      workspace,
      runRoot: paths.root,
      timeoutMs: config.commandTimeoutMs,
      maxOutputChars: MAX_TOOL_OUTPUT,
      maxSteps,
      ...(extensions.mcpTools.length === 0 ? {} : { mcpTools: extensions.mcpTools }),
      ...(extensions.skills.length === 0 ? {} : { skills: extensions.skills }),
      onEvent: (event) => bus.emit(runEventOf(event.kind, task.id, event.detail)),
    });

    if (worked.report === undefined) {
      const failure = worked.failure ?? "worker 没有交卷";
      bus.emit({ kind: "task_verdict", task: task.id, detail: `没交卷 —— ${failure}` });
      outcomes.push({ taskId: task.id, status: "failed", reasons: [failure], failure });
      remainingSteps = Math.max(0, remainingSteps - worked.steps);
      continue;
    }

    const { verdict, report } = await verify({
      config,
      task,
      report: worked.report,
      workspace,
      runRoot: paths.root,
      ledger: worked.ledger,
      preexistingData: worked.preexistingData,
      timeoutMs: config.commandTimeoutMs,
      onEvent: (detail) => bus.emit({ kind: "task_step", task: task.id, detail }),
    });

    await writeReport(paths, report);
    bus.emit({ kind: "task_verdict", task: task.id, detail: `${verdict.status} —— ${verdict.reasons[0] ?? ""}` });
    outcomes.push({ taskId: task.id, status: verdict.status, reasons: verdict.reasons });
    remainingSteps = Math.max(0, remainingSteps - worked.steps);
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

/**
 * 往已有的任务树上**追加**任务,然后只跑新的那些。
 *
 * 这是"第二次输入"该有的行为:不是开一次全新的运行、把之前的工作当成陌生
 * 文件重新理解一遍,而是在同一棵树上接着说。
 *
 * 两条规矩决定了它和"重来"的区别:
 *
 * 1. **只准加,不准改。** planner 看不到"改写已有任务"这个选项 ——
 *    旧任务书写的是当时我们决定怎么验,改它就是篡改记录。想改就新增一条覆盖它。
 * 2. **跨时间的依赖是写出来的。** 新任务可以 depends_on 指到几个月前的任务号,
 *    这条关系留在图里,而不是消失在"这是另一次运行"里。
 */
export async function continueRun(
  config: Config,
  workspace: string,
  runId: string,
  goal: string,
  images: IncomingImage[] = [],
  onEvent?: (event: RunEvent) => void,
): Promise<ContinueResult> {
  const paths = runPaths(workspace, runId);
  const bus = createEventBus(paths, runId);
  if (onEvent !== undefined) bus.subscribe(onEvent);

  // 规划和执行共用同一批外挂 —— 否则会起两遍 MCP 进程,前一遍还没人关
  const extensions = await loadExtensions({
    config,
    workspace,
    onEvent: (detail) => bus.emit({ kind: "task_step", task: "run", detail }),
  });

  try {
    return await continueWith(config, workspace, runId, goal, images, paths, bus, extensions, onEvent);
  } finally {
    extensions.close();
  }
}

async function continueWith(
  config: Config,
  workspace: string,
  runId: string,
  goal: string,
  images: IncomingImage[],
  paths: RunPaths,
  bus: EventBus,
  extensions: Extensions,
  onEvent?: (event: RunEvent) => void,
): Promise<ContinueResult> {
  const tasks = await loadTasks(paths);

  // 现有任务 + 它们的裁定,原样交给 planner —— 它得知道自己站在什么上面
  const existing: ExistingTask[] = [];
  for (const task of tasks) {
    const report = await readReport(paths, task.id);
    existing.push({ id: task.id, title: task.title, status: report?.status ?? "还没做" });
  }

  // 图和一次性运行一样:先落盘,任务书引用它们的路径
  const planned: PlanImage[] = [];
  for (const [index, image] of images.entries()) {
    const saved = await saveImage(paths.root, index, image);
    if ("error" in saved) {
      bus.emit({ kind: "task_step", task: "planner", detail: `第 ${index + 1} 张图没能保存:${saved.error}` });
      continue;
    }
    planned.push({ path: saved.path, dataUrl: image.dataUrl });
  }

  bus.emit({ kind: "run_start", detail: `接着做:${goal}` });

  const result = await plan({
    config,
    goal,
    workspace,
    runRoot: paths.root,
    timeoutMs: config.commandTimeoutMs,
    maxOutputChars: MAX_TOOL_OUTPUT,
    discoveryTools,
    maxSteps: config.plannerSteps,
    existing,
    ...(planned.length === 0 ? {} : { images: planned }),
    ...(extensions.skills.length === 0 ? {} : { skills: extensions.skills }),
    onEvent: (event) => bus.emit(runEventOf(event.kind, "planner", event.detail)),
  });

  if (result.tasks.length === 0) {
    const why = result.failure ?? "planner 认为现状已经满足这次要求,没有要新增的任务。";
    bus.emit({ kind: "run_done", detail: why });
    return { planned: [], nothingToDo: result.failure === undefined, outcomes: [] };
  }

  for (const task of result.tasks) await writeTask(paths, task);
  bus.emit({ kind: "plan_done", detail: `追加 ${result.tasks.length} 个任务` });

  const outcomes = await resumeRun(config, workspace, runId, result.tasks.map((task) => task.id), onEvent, extensions);

  return { planned: result.tasks, nothingToDo: false, outcomes };
}
