import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verify } from "./agent/verifier.ts";
import type { Config } from "./config.ts";
import { fatalFindings, lintReport } from "./doc/lint.ts";
import { parseReportDoc, type ReportDoc } from "./doc/report.ts";
import { parseTaskDoc, type TaskDoc } from "./doc/task.ts";
import { agentSpan, withRunTelemetry } from "./telemetry.ts";
import { writeReport, listRunIds, readRunDoc, runPaths, type RunPaths } from "./workspace.ts";

export interface CheckResult {
  runId: string;
  /** 一共看了几份文档,用来区分「全过」和「根本没文档」。 */
  documents: number;
  problems: string[];
}

async function markdownIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

async function loadTasks(paths: RunPaths): Promise<{ tasks: TaskDoc[]; problems: string[] }> {
  const tasks: TaskDoc[] = [];
  const problems: string[] = [];

  for (const id of await markdownIds(paths.tasksDir)) {
    const raw = await readFile(join(paths.tasksDir, `${id}.md`), "utf8");
    const { task, errors } = parseTaskDoc(raw);
    if (task === undefined) {
      problems.push(`任务书 ${id}.md:${errors.join(";")}`);
      continue;
    }
    tasks.push(task);
  }

  return { tasks, problems };
}

async function loadReports(paths: RunPaths): Promise<{ reports: ReportDoc[]; problems: string[] }> {
  const reports: ReportDoc[] = [];
  const problems: string[] = [];

  for (const id of await markdownIds(paths.reportsDir)) {
    const raw = await readFile(join(paths.reportsDir, `${id}.md`), "utf8");
    const { report, errors } = parseReportDoc(raw);
    if (report === undefined) {
      problems.push(`报告 ${id}.md:${errors.join(";")}`);
      continue;
    }
    reports.push(report);
  }

  return { reports, problems };
}

/**
 * 只做机械校验:文档合不合 schema、有没有踩禁词、证据是不是齐。
 *
 * 不跑验收命令、不碰模型 —— 所以它能进 CI,也能在没有 API key 的机器上跑。
 */
export async function checkWorkspace(workspace: string, only?: string): Promise<CheckResult[]> {
  const ids = only === undefined ? await listRunIds(workspace) : [only];
  const results: CheckResult[] = [];

  for (const runId of ids) {
    const paths = runPaths(workspace, runId);
    const problems: string[] = [];

    const { tasks, problems: taskProblems } = await loadTasks(paths);
    const { reports, problems: reportProblems } = await loadReports(paths);
    problems.push(...taskProblems, ...reportProblems);

    const byId = new Map(tasks.map((task) => [task.id, task]));

    for (const report of reports) {
      const task = byId.get(report.task);
      const findings = lintReport(report, task);

      for (const finding of findings) {
        problems.push(`${report.task} [${finding.rule}] ${finding.where}:${finding.detail}`);
      }

      if (task === undefined) {
        problems.push(`${report.task}:有报告但没有对应的任务书。`);
        continue;
      }

      // 自己说 verified,机械校验却过不去 —— 这是最该报出来的一种不一致
      if (report.status === "verified" && fatalFindings(findings, task).length > 0) {
        problems.push(`${report.task}:标着 verified,但机械校验过不去。`);
      }
    }

    for (const id of await markdownIds(paths.tasksDir)) {
      if (!reports.some((report) => report.task === id)) {
        problems.push(`${id}:有任务书但没有交付报告。`);
      }
    }

    results.push({ runId, documents: tasks.length + reports.length, problems });
  }

  return results;
}

export interface ReverifyOutcome {
  task: string;
  status: string;
  reasons: string[];
}

/**
 * 对已有运行重跑一遍验收。
 *
 * 这是「证据可重放」真正有用的地方:代码后来被改过、环境变过,
 * 拿当时的报告重新跑一遍,就知道那些结论现在还算不算数。
 */
export async function reverify(
  config: Config,
  workspace: string,
  runId: string,
  onEvent?: (detail: string) => void,
): Promise<ReverifyOutcome[]> {
  return await withRunTelemetry(config, runId, `重验 ${runId}`, () =>
    reverifyInner(config, workspace, runId, onEvent),
  );
}

async function reverifyInner(
  config: Config,
  workspace: string,
  runId: string,
  onEvent?: (detail: string) => void,
): Promise<ReverifyOutcome[]> {
  const paths = runPaths(workspace, runId);
  const { tasks } = await loadTasks(paths);
  const { reports } = await loadReports(paths);
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const outcomes: ReverifyOutcome[] = [];

  for (const report of reports) {
    const task = byId.get(report.task);
    if (task === undefined) {
      outcomes.push({ task: report.task, status: "failed", reasons: ["没有对应的任务书,无法重验。"] });
      continue;
    }

    onEvent?.(`重验 ${report.task}`);
    const { verdict, report: updated } = await agentSpan("verifier", { "mastic.task.id": task.id }, () =>
      verify({
        config,
        task,
        report,
        workspace,
        runRoot: paths.root,
        // 重判旧报告时没有当时的台账,数据溯源这一项跳过 ——
        // 它需要知道那一轮读过什么,而那个信息只活在 worker 的内存里
        ledger: { commands: [], files: [] },
        preexistingData: [],
        timeoutMs: config.commandTimeoutMs,
        onEvent: (detail) => onEvent?.(`  ${detail}`),
      }),
    );

    await writeReport(paths, updated);
    outcomes.push({ task: report.task, status: verdict.status, reasons: verdict.reasons });
  }

  return outcomes;
}

/** 给 check 用:把一次运行的元信息取出来,顺手确认它存在。 */
export async function describeRun(workspace: string, runId: string): Promise<string | undefined> {
  const doc = await readRunDoc(runPaths(workspace, runId));
  return doc?.goal;
}
