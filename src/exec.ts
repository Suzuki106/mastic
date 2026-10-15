import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** 回灌给人的输出上限。哈希不受这个影响,见下。 */
const MAX_CAPTURE_BYTES = 256 * 1024;

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  /**
   * 完整 stdout 的 sha256。
   *
   * 注意是对**全部**字节算的,和下面被截断的 `stdout` 无关 ——
   * 输出很长时我们只能留一截给人看,但证据要对账的是完整那一份。
   */
  stdoutSha256: string;
  stdoutBytes: number;
  /** 截断后的 stdout,只用于显示。 */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 跑一条命令。
 *
 * 自己计时杀进程,而不是用 spawn 的 `timeout` 选项 —— 那个和别的 SIGKILL
 * 混在一起,分不清「超时」还是「被外部杀了」,而这两件事对验收的含义完全不同。
 */
export async function runCommand(command: string, options: RunOptions): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const startedAt = Date.now();
    const hash = createHash("sha256");
    let stdoutBytes = 0;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      // 环境变量原样传下去,但关掉交互式分页,免得命令卡在等输入上
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      stdoutBytes += chunk.length;
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: options.cwd,
        // 被信号杀掉时 code 是 null,记 -1 —— 反正不会等于任何期望的退出码
        exitCode: code ?? -1,
        stdoutSha256: hash.digest("hex"),
        stdoutBytes,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
