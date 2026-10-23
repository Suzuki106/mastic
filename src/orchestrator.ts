import { plan, type PlanImage } from "./agent/planner.ts";
import { saveImage, type IncomingImage } from "./attachments.ts";
import { verify } from "./agent/verifier.ts";
import { work } from "./agent/worker.ts";
import type { Config } from "./config.ts";
import { topoLayers } from "./doc/plan.ts";
import type { ReportDoc, ReportStatus } from "./doc/report.ts";
import type { TaskDoc } from "./doc/task.ts";
import { createEventBus, runEventOf, type RunEvent } from "./events.ts";
import { loadExtensions, type Extensions } from "./extensions.ts";
import type { LoopEvent } from "./agent/loop.ts";
import type { Usage } from "./llm.ts";
import { discoveryTools } from "./tools/index.ts";
import {
  createRun,
  newRunId,
  writeReport,
  writeRunDoc,
  writeTask,
  type RunPaths,
  type RunUsage,
} from "./workspace.ts";

/** 每个任务最多回灌多少字符。工具本身也会截断,这里是二次保险。 */
const MAX_TOOL_OUTPUT = 30_000;

export interface TaskOutcome {
  task: TaskDoc;
  report?: ReportDoc;
  status: ReportStatus | "failed" | "skipped";
  attempts: number;
  failure?: string;
  /** 这个任务(含重试)用掉几步。运行级预算按它扣。 */
  steps: number;
  /** 这个任务(含重试)烧掉的 token。 */
  usage: RunUsage;
}

export interface OrchestrateOptions {
  config: Config;
  goal: string;
  workspace: string;
  /** 每个任务最多拆成几步 —— planner 自己的预算。 */
  planSteps?: number;
  /**
   * 由调用方指定 run id。
   *
   * Web 界面需要**先**拿到 id 才能把地址切过去、才能订阅事件流,
   * 所以它自己生成 id 传进来,而不是等这里返回。
   */
  runId?: string;
  /** 用户取消。在每个任务开跑前检查一次 —— 不打断正在跑的任务。 */
  signal?: AbortSignal;
  /** 用户随需求一起传上来的图。会落盘到本次运行的 attachments/ 下。 */
  images?: IncomingImage[];
  onEvent?: (event: RunEvent) => void;
}

export interface OrchestrateResult {
  runId: string;
  paths: RunPaths;
  outcomes: TaskOutcome[];
  usage: RunUsage;
  failure?: string;
}

function addUsage(total: RunUsage, next: Usage | null): RunUsage {
  if (next === null) return total;
  return {
    prompt_tokens: total.prompt_tokens + (next.prompt_tokens ?? 0),
    completion_tokens: total.completion_tokens + (next.completion_tokens ?? 0),
    total_tokens: total.total_tokens + (next.total_tokens ?? 0),
  };
}

/**
 * 一个任务能拿多少步。
 *
 * **剩余预算 ÷ 还没开始的任务数**,再压到硬顶之下。
 *
 * 关键是这里没有模型的位置:数从哪来、怎么分,都是固定规则。原先每份任务书里
 * 写着 planner 拍的 `max_steps`,而那个数没有刻度 —— 它这次的"30"和下次的"30"
 * 对应的难度不是一个东西。**不可比的数不能用来分配资源。**
 *
 * 于是:先做的任务剩余多、拿得多,后做的拿得少,加起来不超过总预算。
 */
export function allocateSteps(remaining: number, tasksLeft: number, ceiling: number): number {
  if (tasksLeft <= 0) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(remaining / tasksLeft)));
}

/** 并发闸门:同时最多 limit 个在跑,跑完一个补一个。 */
export async function runPool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];

  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await run(item);
    }
  });

  await Promise.all(runners);
}

/** 一个任务做完了没 —— 只有这两个状态算「过了」,其余都要拦下游。 */
function passed(outcome: TaskOutcome | undefined): boolean {
  return outcome?.status === "verified" || outcome?.status === "unverified";
}

/**
 * 跑一个任务,直到验过或者用满重试。
 *
 * 注意这里**没有**「重试用尽就放行」这种逻辑。用尽了就落 contradicted 或 failed,
 * 并且把卡在哪原样写进报告 —— 失败是合法终态,谎报不是。
 */
async function runTask(
  options: OrchestrateOptions,
  paths: RunPaths,
  emit: (event: Omit<RunEvent, "seq" | "at" | "run">) => void,
  task: TaskDoc,
  maxSteps: number,
  extensions: Extensions,
): Promise<TaskOutcome> {
  const maxAttempts = options.config.maxRetries + 1;
  let findings: string[] | undefined;
  let lastFailure = "没有尝试过";
  let lastStatus: "contradicted" | "failed" = "failed";
  let usage: RunUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let usedSteps = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    emit({
      kind: "task_start",
      task: task.id,
      detail: attempt === 1 ? "开始" : `第 ${attempt} 次尝试`,
    });

    const worked = await work({
      config: options.config,
      task,
      workspace: options.workspace,
      runRoot: paths.root,
      timeoutMs: options.config.commandTimeoutMs,
      maxOutputChars: MAX_TOOL_OUTPUT,
      maxSteps,
      ...(findings === undefined ? {} : { findings }),
      ...(extensions.mcpTools.length === 0 ? {} : { mcpTools: extensions.mcpTools }),
      ...(extensions.skills.length === 0 ? {} : { skills: extensions.skills }),
      onEvent: (event) => emit(runEventOf(event.kind, task.id, event.detail)),
    });

    usage = addUsage(usage, worked.usage);
    usedSteps += worked.steps;

    if (worked.report === undefined) {
      lastFailure = worked.failure ?? "worker 没有交卷";
      lastStatus = "failed";
      findings = [lastFailure];
      continue;
    }

    const { verdict, report, usage: verifyUsage } = await verify({
      config: options.config,
      task,
      report: worked.report,
      workspace: options.workspace,
      runRoot: paths.root,
      ledger: worked.ledger,
      preexistingData: worked.preexistingData,
      timeoutMs: options.config.commandTimeoutMs,
      onEvent: (detail) => emit({ kind: "task_step", task: task.id, detail }),
    });

    usage = addUsage(usage, verifyUsage);
    await writeReport(paths, report);

    emit({
      kind: "task_verdict",
      task: task.id,
      detail: `${verdict.status} —— ${verdict.reasons[0] ?? ""}`,
    });

    if (verdict.status !== "contradicted") {
      return { task, report, status: verdict.status, attempts: attempt, usage, steps: usedSteps };
    }

    lastFailure = verdict.reasons.join(";");
    lastStatus = "contradicted";
    findings = verdict.reasons;

    if (attempt < maxAttempts) {
      emit({
        kind: "task_retry",
        task: task.id,
        detail: `重派:${verdict.reasons[0] ?? "验收未通过"}`,
      });
    }
  }

  return {
    task,
    status: lastStatus,
    attempts: maxAttempts,
    failure: `重试 ${options.config.maxRetries} 次仍未通过:${lastFailure}`,
    usage,
    steps: usedSteps,
  };
}

/**
 * 起一次运行。
 *
 * 外面这层只管一件事:**崩了也要留下痕迹**。
 *
 * 原先不是这样:任务执行里任何一处抛异常,都会直接冲出去,于是
 * `writeRunDoc` 永远走不到,`run.md` 就停在 `status: running` ——
 * 界面看不出它已经死了,磁盘上也没有任何记录说明为什么。
 * 一次真实运行就这么无声无息地挂了七个多小时,留下的只有一份说
 * "还在跑"的 run.md。
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const runId = options.runId ?? newRunId();
  const paths = await createRun(options.workspace, runId);
  const bus = createEventBus(paths, runId);
  if (options.onEvent !== undefined) bus.subscribe(options.onEvent);

  const startedAt = new Date().toISOString();
  const empty: RunUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let extensions: Extensions | undefined;

  try {
    // MCP 服务是外部进程 —— 起在运行开始时、关在 finally 里。
    // 加载失败只记一条事件,不该让整次运行连试都不试。
    extensions = await loadExtensions({
      config: options.config,
      workspace: options.workspace,
      onEvent: (detail) => bus.emit({ kind: "task_step", task: "run", detail }),
    });

    return await runOrchestration(options, paths, bus, startedAt, extensions);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    bus.emit({ kind: "run_done", detail: `出错终止:${reason}` });

    await writeRunDoc(paths, {
      id: runId,
      goal: options.goal,
      workspace: options.workspace,
      created_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
    });

    return { runId, paths, outcomes: [], usage: empty, failure: `运行中断:${reason}` };
  } finally {
    extensions?.close();
  }
}

async function runOrchestration(
  options: OrchestrateOptions,
  paths: RunPaths,
  bus: ReturnType<typeof createEventBus>,
  createdAt: string,
  extensions: Extensions,
): Promise<OrchestrateResult> {
  const runId = paths.root.split("/").pop() ?? "";
  const emptyUsage: RunUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  await writeRunDoc(paths, {
    id: runId,
    goal: options.goal,
    workspace: options.workspace,
    created_at: createdAt,
    status: "running",
  });

  bus.emit({ kind: "run_start", detail: options.goal });

  // 图片先落盘再规划:它们是这次运行的记录,任务书会引用这些路径,
  // 事后翻回来得能看到当时那张图。
  const images: PlanImage[] = [];
  for (const [index, image] of (options.images ?? []).entries()) {
    const saved = await saveImage(paths.root, index, image);
    if ("error" in saved) {
      bus.emit({ kind: "task_step", task: "planner", detail: `第 ${index + 1} 张图没能保存:${saved.error}` });
      continue;
    }
    images.push({ path: saved.path, dataUrl: image.dataUrl });
  }

  if (images.length > 0) {
    bus.emit({
      kind: "task_step",
      task: "planner",
      detail: `带 ${images.length} 张附图:${images.map((image) => image.path).join("、")}`,
    });
  }

  const planned = await plan({
    config: options.config,
    goal: options.goal,
    workspace: options.workspace,
    runRoot: paths.root,
    ...(images.length === 0 ? {} : { images }),
    ...(extensions.skills.length === 0 ? {} : { skills: extensions.skills }),
    timeoutMs: options.config.commandTimeoutMs,
    maxOutputChars: MAX_TOOL_OUTPUT,
    discoveryTools,
    maxSteps: options.planSteps ?? options.config.plannerSteps,
    // kind 要原样带过去 —— 尤其 thinking:"还在请求模型"和"读完一个文件"
    // 在前端是两种东西,压成一种就画不出进行中的状态了
    onEvent: (event) => bus.emit(runEventOf(event.kind, "planner", event.detail)),
  });

  const plannerUsage = addUsage(emptyUsage, planned.usage);

  if (planned.tasks.length === 0) {
    const failure = planned.failure ?? "planner 没能产出任务树";
    bus.emit({ kind: "run_done", detail: `失败:${failure}` });
    await writeRunDoc(paths, {
      id: runId,
      goal: options.goal,
      workspace: options.workspace,
      created_at: createdAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      usage: plannerUsage,
    });
    return { runId, paths, outcomes: [], usage: plannerUsage, failure };
  }

  for (const task of planned.tasks) await writeTask(paths, task);

  const layers = topoLayers(planned.tasks);
  bus.emit({
    kind: "plan_done",
    detail: `${planned.tasks.length} 个任务,${layers.length} 层依赖`,
  });

  const outcomes = new Map<string, TaskOutcome>();
  // 运行级预算。用掉多少扣多少 —— 按实际消耗,不按上限。
  let remainingSteps = options.config.runBudgetSteps;

  for (const layer of layers) {
    // 取消只在任务边界生效 —— 不打断正在跑的那个,免得留下半截工作区
    if (options.signal?.aborted === true) {
      for (const task of planned.tasks) {
        if (outcomes.has(task.id)) continue;
        outcomes.set(task.id, {
          task,
          status: "skipped",
          attempts: 0,
          failure: "用户取消了这次运行。",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          steps: 0,
        });
      }
      bus.emit({ kind: "run_done", detail: "已取消" });
      break;
    }

    // 预算用完了就不再往下做。这是**运行级**的事实,不是某个任务运气不好 ——
    // 报的是"还剩几个没做",而不是"T-001 用了 30 步所以失败"。
    if (remainingSteps <= 0) {
      for (const task of planned.tasks) {
        if (outcomes.has(task.id)) continue;
        outcomes.set(task.id, {
          task,
          status: "skipped",
          attempts: 0,
          failure: `这次运行的步数预算(${options.config.runBudgetSteps})用完了,没轮到它。`,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          steps: 0,
        });
        bus.emit({ kind: "task_skipped", task: task.id, detail: "预算用完了" });
      }
      break;
    }

    const runnable: TaskDoc[] = [];

    for (const task of layer) {
      const brokenDeps = task.depends_on.filter((dep) => !passed(outcomes.get(dep)));

      if (brokenDeps.length > 0) {
        const failure = `依赖 ${brokenDeps.join("、")} 没有通过,不往下做了。`;
        outcomes.set(task.id, {
          task,
          status: "skipped",
          attempts: 0,
          failure,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          steps: 0,
        });
        bus.emit({ kind: "task_skipped", task: task.id, detail: failure });
        continue;
      }

      runnable.push(task);
    }

    // 这一层每个任务能拿多少:在派活之前一次算好。
    // 写进回调里算的话,并行起来的几个任务会各读一次同一个剩余量,分不准。
    const notStarted = planned.tasks.filter((task) => !outcomes.has(task.id)).length;
    const layerLimit = allocateSteps(remainingSteps, notStarted, options.config.taskStepCeiling);

    let layerUsed = 0;
    await runPool(runnable, options.config.concurrency, async (task) => {
      const outcome = await runTask(options, paths, (event) => bus.emit(event), task, layerLimit, extensions);
      layerUsed += outcome.steps;
      outcomes.set(task.id, outcome);
    });

    remainingSteps = Math.max(0, remainingSteps - layerUsed);
  }

  const ordered = planned.tasks.map((task) => outcomes.get(task.id)).filter((o): o is TaskOutcome => o !== undefined);

  const totalUsage = ordered.reduce<RunUsage>(
    (acc, outcome) => ({
      prompt_tokens: acc.prompt_tokens + outcome.usage.prompt_tokens,
      completion_tokens: acc.completion_tokens + outcome.usage.completion_tokens,
      total_tokens: acc.total_tokens + outcome.usage.total_tokens,
    }),
    plannerUsage,
  );

  const finishedAt = new Date().toISOString();
  const tally = ordered.reduce<Record<string, number>>((acc, outcome) => {
    acc[outcome.status] = (acc[outcome.status] ?? 0) + 1;
    return acc;
  }, {});

  bus.emit({
    kind: "run_done",
    detail: Object.entries(tally)
      .map(([status, count]) => `${status} ${count}`)
      .join(" · "),
  });

  await writeRunDoc(paths, {
    id: runId,
    goal: options.goal,
    workspace: options.workspace,
    created_at: createdAt,
    finished_at: finishedAt,
    status: "done",
    usage: totalUsage,
  });

  return { runId, paths, outcomes: ordered, usage: totalUsage };
}
