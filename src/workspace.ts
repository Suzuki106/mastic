import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocError, parseDoc, serialiseDoc } from "./doc/frontmatter.ts";
import { parseReportDoc, renderReportDoc, type ReportDoc } from "./doc/report.ts";
import { parseTaskDoc, renderTaskDoc, type TaskDoc } from "./doc/task.ts";
import { resolveInside } from "./paths.ts";

/**
 * 一次运行的全部落盘位置。
 *
 * 任务书、交付报告、事件流都在 run 目录里 —— 「多 agent 之间靠文档通信」
 * 这句话的物理形态就是这个目录。
 */
export interface RunPaths {
  /** <workspace>/.mastic/runs/<id> */
  root: string;
  runDoc: string;
  tasksDir: string;
  reportsDir: string;
  eventsFile: string;
}

export interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RunDoc {
  id: string;
  goal: string;
  workspace: string;
  created_at: string;
  finished_at?: string;
  status: "running" | "done" | "failed";
  usage?: RunUsage;
}

/** 时间戳 + 随机后缀:同一秒发起两次也不会撞车。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function runPaths(workspace: string, id: string): RunPaths {
  const root = resolveInside(workspace, join(".mastic", "runs", id));
  return {
    root,
    runDoc: join(root, "run.md"),
    tasksDir: join(root, "tasks"),
    reportsDir: join(root, "reports"),
    eventsFile: join(root, "events.jsonl"),
  };
}

export async function createRun(workspace: string, id: string): Promise<RunPaths> {
  const paths = runPaths(workspace, id);
  await mkdir(paths.tasksDir, { recursive: true });
  await mkdir(paths.reportsDir, { recursive: true });
  return paths;
}

export async function writeRunDoc(paths: RunPaths, doc: RunDoc): Promise<void> {
  const { status, finished_at, usage, ...rest } = doc;
  const data: Record<string, unknown> = { ...rest, status };
  if (finished_at !== undefined) data.finished_at = finished_at;
  if (usage !== undefined) data.usage = usage;

  await writeFile(paths.runDoc, serialiseDoc(data, "## 目标\n\n" + doc.goal + "\n"), "utf8");
}

export async function writeTask(paths: RunPaths, task: TaskDoc): Promise<void> {
  await writeFile(join(paths.tasksDir, `${task.id}.md`), renderTaskDoc(task), "utf8");
}

/**
 * 报告写到任务书指定的 `deliverable` 路径。
 *
 * 路径来自任务书,所以仍然过一遍 resolveInside —— 挡掉 `../` 这类越界。
 */
export async function writeReport(paths: RunPaths, report: ReportDoc): Promise<string> {
  const relative = `reports/${report.task}.md`;
  const target = resolveInside(paths.root, relative);
  await writeFile(target, renderReportDoc(report), "utf8");
  return relative;
}

export async function readTask(paths: RunPaths, id: string): Promise<TaskDoc | undefined> {
  try {
    const raw = await readFile(join(paths.tasksDir, `${id}.md`), "utf8");
    return parseTaskDoc(raw).task;
  } catch {
    return undefined;
  }
}

export async function readReport(paths: RunPaths, id: string): Promise<ReportDoc | undefined> {
  try {
    const raw = await readFile(join(paths.reportsDir, `${id}.md`), "utf8");
    return parseReportDoc(raw).report;
  } catch {
    return undefined;
  }
}

export async function readRunDoc(paths: RunPaths): Promise<RunDoc | undefined> {
  try {
    const { data } = parseDoc(await readFile(paths.runDoc, "utf8"));
    return data as unknown as RunDoc;
  } catch (error) {
    if (error instanceof DocError) return undefined;
    throw error;
  }
}

export async function listRunIds(workspace: string): Promise<string[]> {
  const runsDir = resolveInside(workspace, join(".mastic", "runs"));
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 最近一次运行 —— `mastic ui` 不带参数时用它。 */
export async function latestRunId(workspace: string): Promise<string | undefined> {
  const ids = await listRunIds(workspace);
  return ids.at(-1);
}
