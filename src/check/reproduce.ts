import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReproducibleCheck, TaskDoc } from "../doc/task.ts";
import { runCommand, type CommandResult } from "../exec.ts";
import { displayPath, resolveInside } from "../paths.ts";

/** 默认的相对容差。浮点训练几乎不可能逐字节一致,但 1e-6 级的差异通常是同一结果。 */
const DEFAULT_TOLERANCE = 1e-6;

export interface ReproducibleOutcome {
  check: ReproducibleCheck;
  passed: boolean;
  detail: string;
  /** 每一遍的命令结果,写进报告当带证据的东西。 */
  runs: CommandResult[];
}

/** 把 `{out}` 换成这一遍自己的输出目录。 */
export function withOut(command: string, index: number): string {
  return command.replace(/\{out\}/g, `repro-${index}`);
}

export interface NumericProblem {
  path: string;
  detail: string;
}

/**
 * 深度比对两个 JSON 值。
 *
 * 数字按容差比,其余(字符串、布尔、null)必须完全相等;结构必须一样。
 * 不做"差不多"判断 —— 缺一个字段、多一个字段都算不一样。
 */
export function compareNumeric(
  a: unknown,
  b: unknown,
  tolerance: number,
  path = "$",
): NumericProblem | null {
  if (typeof a === "number" && typeof b === "number") {
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > tolerance * scale) {
      return { path, detail: `${a} vs ${b}(差 ${Math.abs(a - b).toExponential(2)},容差 ${tolerance})` };
    }
    return null;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path, detail: `数组长度不同:${a.length} vs ${b.length}` };
    for (let i = 0; i < a.length; i += 1) {
      const problem = compareNumeric(a[i], b[i], tolerance, `${path}[${i}]`);
      if (problem !== null) return problem;
    }
    return null;
  }

  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!(key in left)) return { path: `${path}.${key}`, detail: "第二遍多出这个字段" };
      if (!(key in right)) return { path: `${path}.${key}`, detail: "第二遍缺这个字段" };
      const problem = compareNumeric(left[key], right[key], tolerance, `${path}.${key}`);
      if (problem !== null) return problem;
    }
    return null;
  }

  if (a !== b) {
    return { path, detail: `${JSON.stringify(a)} vs ${JSON.stringify(b)}` };
  }
  return null;
}

function compareFiles(
  left: Buffer,
  right: Buffer,
  mode: "exact" | "numeric",
  tolerance: number,
): string | null {
  if (mode === "exact") {
    return left.equals(right) ? null : "两次输出的字节不同";
  }

  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(left.toString("utf8"));
    b = JSON.parse(right.toString("utf8"));
  } catch {
    return "mode 是 numeric,但文件不是合法 JSON";
  }

  const problem = compareNumeric(a, b, tolerance);
  return problem === null ? null : `数值对不上 —— ${problem.path}:${problem.detail}`;
}

export interface ReproduceOptions {
  workspace: string;
  timeoutMs: number;
  onRun?: (command: string, index: number, result: CommandResult) => void;
}

/**
 * 跑 reproducible 级验收:把实验再做一遍,比结果。
 *
 * 这是"复现"这两个字真正指的东西。`command` 级只是跑一遍看着对 ——
 * 它证明不了这套输入和代码能否再得出同一个结果。
 */
export async function runReproducibleChecks(
  task: TaskDoc,
  options: ReproduceOptions,
): Promise<ReproducibleOutcome[]> {
  const outcomes: ReproducibleOutcome[] = [];

  for (const check of task.acceptance) {
    if (check.kind !== "reproducible") continue;

    const cwd = resolveInside(options.workspace, check.cwd ?? ".");
    const results: CommandResult[] = [];
    const problems: string[] = [];

    for (let index = 1; index <= check.runs; index += 1) {
      const command = withOut(check.run, index);
      const result = await runCommand(command, { cwd, timeoutMs: options.timeoutMs });
      results.push(result);
      options.onRun?.(command, index, result);

      if (result.exitCode !== 0) {
        problems.push(`第 ${index} 遍退出码 ${result.exitCode}${result.timedOut ? "(超时)" : ""}`);
      }
    }

    if (problems.length === 0) {
      for (const item of check.compare) {
        const tolerance = item.tolerance ?? DEFAULT_TOLERANCE;

        let baseline: Buffer;
        try {
          baseline = await readFile(resolveInside(options.workspace, join(withOut(item.path, 1))));
        } catch {
          problems.push(`第 1 遍没有产出 ${withOut(item.path, 1)}`);
          continue;
        }

        for (let index = 2; index <= check.runs; index += 1) {
          const relative = withOut(item.path, index);
          let other: Buffer;
          try {
            other = await readFile(resolveInside(options.workspace, join(relative)));
          } catch {
            problems.push(`第 ${index} 遍没有产出 ${relative}`);
            continue;
          }

          const problem = compareFiles(baseline, other, item.mode, tolerance);
          if (problem !== null) {
            problems.push(`${item.path}:第 1 遍和第 ${index} 遍 —— ${problem}`);
          }
        }
      }
    }

    outcomes.push({
      check,
      passed: problems.length === 0,
      detail:
        problems.length === 0
          ? `跑了 ${check.runs} 遍,${check.compare.length} 项结果一致`
          : problems.join(";"),
      runs: results,
    });
  }

  return outcomes;
}

/** 给日志用的短路径。 */
export function relativeTo(workspace: string, path: string): string {
  return displayPath(workspace, path);
}
