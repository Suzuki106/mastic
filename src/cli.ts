import { loadConfig, type Config } from "./config.ts";
import type { RunEvent } from "./events.ts";
import { runEvidenceCommand } from "./evidence/cli.ts";
import { checkWorkspace, reverify } from "./inspect.ts";
import { orchestrate, type TaskOutcome } from "./orchestrator.ts";
import { displayPath } from "./paths.ts";
import { resumeRun } from "./resume.ts";
import { startServer } from "./server.ts";
import { latestRunId } from "./workspace.ts";

const HELP = `mastic —— 给 agent 产出做确定性判定

用法:
  mastic run "<目标>"        把目标拆成任务树,并行跑,逐任务验收
  mastic ui [run-id]         打开 Web 界面(默认最近一次运行)
  mastic resume [run-id] [任务号…]
                             续跑没做完的任务(不重新规划,沿用现成任务书)
  mastic verify [run-id]     对已有运行重跑一遍验收(证据重放 + 验收命令)
  mastic check [run-id]      只校验文档合不合规,不跑命令、不碰模型(可进 CI)
  mastic evidence <verify|chain|trace> …
                             不跑 agent,只重放证据 / 验溯源链(可进 CI,无需 key)
  mastic help

可选项:
  --workspace <路径>   agent 动手的目录(默认当前目录)
  --concurrency <n>    同时跑几个 worker(默认 3)
  --retries <n>        被判定 contradicted 后最多重派几次(默认 2)
  --plan-steps <n>     planner 最多几步(默认 40)
  --port <n>           ui 的端口(默认 7777)
  --quiet              只在最后打印总结
  --json               evidence 子命令输出机器可读结果
`;

/** 状态色。前端有前端的一套,这里只管终端。 */
const COLORS: Record<string, string> = {
  verified: "\u001b[32m",
  unverified: "\u001b[33m",
  contradicted: "\u001b[31m",
  blocked: "\u001b[35m",
  failed: "\u001b[31m",
  skipped: "\u001b[90m",
};
const DIM = "\u001b[90m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";

function paint(status: string): string {
  const color = COLORS[status];
  return color === undefined ? status : `${color}${status}${RESET}`;
}

interface Flags {
  workspace?: string;
  concurrency?: number;
  retries?: number;
  planSteps?: number;
  port?: number;
  quiet: boolean;
  json: boolean;
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { quiet: false, json: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === "--quiet") {
      flags.quiet = true;
      continue;
    }

    if (arg === "--json") {
      flags.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} 后面缺一个值`);

      const parsed = Number(value);
      switch (arg) {
        case "--workspace":
          flags.workspace = value;
          break;
        case "--concurrency":
        case "--retries":
        case "--plan-steps":
        case "--port": {
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new Error(`${arg} 得是正整数,收到 "${value}"`);
          }
          if (arg === "--concurrency") flags.concurrency = parsed;
          if (arg === "--retries") flags.retries = parsed;
          if (arg === "--plan-steps") flags.planSteps = parsed;
          if (arg === "--port") flags.port = parsed;
          break;
        }
        default:
          throw new Error(`不认识的选项 ${arg}`);
      }

      i += 1;
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

function overridesFrom(flags: Flags): Partial<Config> {
  const overrides: Partial<Config> = {};
  if (flags.workspace !== undefined) overrides.workspace = flags.workspace;
  if (flags.concurrency !== undefined) overrides.concurrency = flags.concurrency;
  if (flags.retries !== undefined) overrides.maxRetries = flags.retries;
  return overrides;
}

/** 事件流的单行渲染。task 是 planner / 任务编号 / 缺省。 */
function printEvent(event: RunEvent, quiet: boolean): void {
  if (quiet && event.kind !== "task_verdict" && event.kind !== "run_done") return;

  const tag = event.task === undefined ? "run" : event.task;

  if (event.kind === "task_verdict") {
    const status = event.detail.split(" —— ")[0] ?? "";
    console.log(`${paint(status)}  ${tag}  ${event.detail.slice(status.length + 4)}`);
    return;
  }

  if (event.kind === "run_start") {
    console.log(`\n目标  ${event.detail}\n`);
    return;
  }

  if (event.kind === "run_done") {
    console.log(`\n完成  ${event.detail}`);
    return;
  }

  console.log(`${DIM}[${tag}]${RESET} ${event.detail}`);
}

function summarise(outcomes: TaskOutcome[], runId: string): void {
  if (outcomes.length === 0) {
    console.log("\n没有任何任务产出。");
    return;
  }

  console.log("\n─── 任务小结 ───");

  for (const outcome of outcomes) {
    const reason = outcome.failure ?? outcome.report?.verdict?.reasons[0] ?? "";
    const attempts = outcome.attempts > 1 ? ` (${outcome.attempts} 次尝试)` : "";
    // 先补齐再上色 —— 带着转义码 padEnd 会把列宽算歪
    console.log(`${outcome.task.id.padEnd(8)} ${paint(outcome.status.padEnd(12))} ${outcome.task.title}${attempts}`);
    if (reason !== "") console.log(`         ${DIM}${reason}${RESET}`);
  }

  const tally = outcomes.reduce<Record<string, number>>((acc, outcome) => {
    acc[outcome.status] = (acc[outcome.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `\n${Object.entries(tally)
      .map(([status, count]) => `${paint(status)} ${count}`)
      .join("  ·  ")}`,
  );
  console.log(`${DIM}文档在 .mastic/runs/${runId}/${RESET}`);
  console.log(`${DIM}看界面:mastic ui ${runId}${RESET}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  const { positional, flags } = parseFlags(argv.slice(1));

  // 先把"命令认不认识、参数够不够"问清楚,再去碰配置 ——
  // 否则打错一个字,收到的却是"缺少 OPENAI_API_KEY",完全指错方向。
  if (
    command !== "check" &&
    command !== "ui" &&
    command !== "run" &&
    command !== "verify" &&
    command !== "resume" &&
    command !== "evidence"
  ) {
    console.log(`还不认识 \`${command}\`。\n`);
    console.log(HELP);
    return;
  }

  if (command === "run" && positional.join(" ").trim() === "") {
    console.error('要跑什么?比如:mastic run "把这个仓库加上 CI 配置"');
    process.exitCode = 1;
    return;
  }

  // evidence 同样不碰模型、不需要 key —— 它是给"不跑 mastic agent"的
  // 运行时留的接口:按格式写报告,拿这里判。
  if (command === "evidence") {
    process.exitCode = await runEvidenceCommand(positional, {
      workspace: flags.workspace ?? process.cwd(),
      json: flags.json,
    });
    return;
  }

  // check 只做机械校验,不碰模型 —— 所以它不需要 API key,能直接进 CI
  if (command === "check") {
    const workspace = flags.workspace ?? process.cwd();
    const results = await checkWorkspace(workspace, positional[0]);

    if (results.length === 0) {
      console.log("没有找到任何运行。");
      return;
    }

    let total = 0;
    for (const result of results) {
      total += result.problems.length;
      const mark = result.problems.length === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(`${mark} ${result.runId}  (${result.documents} 份文档)`);
      for (const problem of result.problems) console.log(`    ${problem}`);
    }

    console.log(total === 0 ? `\n全部合格。` : `\n${total} 处问题。`);
    if (total > 0) process.exitCode = 1;
    return;
  }

  // ui 本身不碰模型 —— 光看界面不需要 key,只有从界面上发起运行才需要
  if (command === "ui") {
    const workspace = flags.workspace ?? process.cwd();
    const requested = positional[0] ?? (await latestRunId(workspace));

    const server = await startServer({
      workspace,
      ...(requested === undefined ? {} : { runId: requested }),
      port: flags.port ?? 7777,
    });

    console.log(`mastic ui   ${server.url}`);
    console.log(`工作区      ${workspace}`);
    console.log(
      requested === undefined
        ? `\n还没有任何运行 —— 打开界面直接新建一个就行。Ctrl-C 退出。`
        : `\n当前运行    ${requested}\n\n界面里也能新建运行;跑着的 mastic run 会自动出现在事件流里。Ctrl-C 退出。`,
    );
    return;
  }

  const config = loadConfig(overridesFrom(flags));

  if (command === "resume") {
    const runId = positional[0] ?? (await latestRunId(config.workspace));
    if (runId === undefined) {
      console.error("还没有任何运行,没什么可续的。");
      process.exitCode = 1;
      return;
    }

    // 后面跟的任务号是要补哪几个;不跟就是"所有还没报告的"
    const taskIds = positional.slice(1);
    console.log(
      taskIds.length > 0 ? `续跑 ${runId} 的 ${taskIds.join("、")}\n` : `续跑 ${runId} 里还没完成的任务\n`,
    );

    const outcomes = await resumeRun(config, config.workspace, runId, taskIds, (event) =>
      printEvent(event, flags.quiet),
    );

    if (outcomes.length === 0) {
      console.log("没有需要补的任务。");
      return;
    }

    console.log("\n─── 续跑结果 ───");
    for (const outcome of outcomes) {
      console.log(`${paint(outcome.status.padEnd(12))} ${outcome.taskId}  ${outcome.reasons[0] ?? outcome.failure ?? ""}`);
    }

    const bad = outcomes.filter((o) => o.status !== "verified" && o.status !== "unverified");
    if (bad.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "verify") {
    const runId = positional[0] ?? (await latestRunId(config.workspace));
    if (runId === undefined) {
      console.error("还没有任何运行,没什么可重验的。");
      process.exitCode = 1;
      return;
    }

    console.log(`重验 ${runId}\n`);
    const outcomes = await reverify(config, config.workspace, runId, (detail) => console.log(detail));

    for (const outcome of outcomes) {
      console.log(`${paint(outcome.status.padEnd(12))} ${outcome.task}  ${outcome.reasons[0] ?? ""}`);
    }

    const bad = outcomes.filter(
      (outcome) => outcome.status !== "verified" && outcome.status !== "unverified",
    );
    if (bad.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const goal = positional.join(" ").trim();

    const result = await orchestrate({
      config,
      goal,
      workspace: config.workspace,
      ...(flags.planSteps === undefined ? {} : { planSteps: flags.planSteps }),
      onEvent: (event) => printEvent(event, flags.quiet),
    });

    if (result.failure !== undefined) {
      console.error(`\n[没跑成] ${result.failure}`);
      process.exitCode = 1;
      return;
    }

    summarise(result.outcomes, result.runId);
    console.log(
      `${DIM}tokens  入 ${result.usage.prompt_tokens}  出 ${result.usage.completion_tokens}` +
        `  共 ${result.usage.total_tokens}${RESET}`,
    );

    // 有任务没通过就以非零退出 —— 让 CI 能靠这个判红
    const bad = result.outcomes.filter(
      (outcome) => outcome.status !== "verified" && outcome.status !== "unverified",
    );
    if (bad.length > 0) process.exitCode = 1;
    return;
  }

}

main().catch((error: unknown) => {
  console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
