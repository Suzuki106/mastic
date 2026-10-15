import type { CommandCheck, TaskDoc } from "../doc/task.ts";
import { runCommand, type CommandResult } from "../exec.ts";
import { PathEscapeError, resolveInside } from "../paths.ts";

export interface CommandCheckOutcome {
  check: CommandCheck;
  passed: boolean;
  detail: string;
  result?: CommandResult;
}

export interface RunOptions {
  workspace: string;
  timeoutMs: number;
  /** 每条检查的实时回调,给事件流用。 */
  onRun?: (command: string, result: CommandResult) => void;
}

/**
 * 按 expect 逐项对账。
 *
 * 写了几项就查几项 —— 不写的那项不参与判定,所以「一条判据都没有」的
 * `expect` 在解析阶段就被拒了:那种验收会永远通过,比没有更糟。
 */
function judge(result: CommandResult, check: CommandCheck): { passed: boolean; details: string[] } {
  const details: string[] = [];
  const { expect } = check;

  if (expect.exit_code !== undefined && result.exitCode !== expect.exit_code) {
    details.push(`退出码是 ${result.exitCode},期望 ${expect.exit_code}`);
  }

  if (expect.stdout_contains !== undefined && !result.stdout.includes(expect.stdout_contains)) {
    details.push(`stdout 里没有出现 \`${expect.stdout_contains}\``);
  }

  if (expect.stdout_matches !== undefined && !new RegExp(expect.stdout_matches).test(result.stdout)) {
    details.push(`stdout 不匹配 /${expect.stdout_matches}/`);
  }

  if (expect.stdout_sha256 !== undefined && result.stdoutSha256 !== expect.stdout_sha256) {
    details.push(`stdout 哈希是 ${result.stdoutSha256.slice(0, 12)}…,期望 ${expect.stdout_sha256.slice(0, 12)}…`);
  }

  if (result.timedOut) {
    details.push(`超过 ${Math.round(result.durationMs / 1000)}s 未结束,已强杀`);
  }

  return { passed: details.length === 0, details };
}

/** 跑掉任务书里所有 command 级验收。structural / statement 级不在这里,见 verdict.ts。 */
export async function runCommandChecks(task: TaskDoc, options: RunOptions): Promise<CommandCheckOutcome[]> {
  const outcomes: CommandCheckOutcome[] = [];

  for (const check of task.acceptance) {
    if (check.kind !== "command") continue;

    let cwd: string;
    try {
      cwd = resolveInside(options.workspace, check.cwd ?? ".");
    } catch (error) {
      const detail = error instanceof PathEscapeError ? error.message : String(error);
      outcomes.push({ check, passed: false, detail });
      continue;
    }

    const result = await runCommand(check.run, { cwd, timeoutMs: options.timeoutMs });
    options.onRun?.(check.run, result);

    const { passed, details } = judge(result, check);
    outcomes.push({
      check,
      passed,
      detail: passed ? `退出码 ${result.exitCode}(${result.durationMs}ms)` : details.join(";"),
      result,
    });
  }

  return outcomes;
}
