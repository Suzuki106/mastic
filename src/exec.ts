import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { span } from "./telemetry.ts";

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
  return await span(
    "execute_tool bash",
    {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "bash",
      // 命令原文可能很长(或带密钥),只留够定位的一截
      "mastic.command": command.length > 200 ? `${command.slice(0, 200)}…` : command,
      "mastic.cwd": options.cwd,
    },
    async (handle) => {
      const result = await runCommandRaw(command, options);
      handle.setAttribute("mastic.exit_code", result.exitCode);
      handle.setAttribute("mastic.timed_out", result.timedOut);
      handle.setAttribute("mastic.duration_ms", result.durationMs);
      return result;
    },
  );
}

async function runCommandRaw(command: string, options: RunOptions): Promise<CommandResult> {
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
      // 自成进程组。这样 `cmd &` 起的后台进程也在这一组里,
      // 收尾时能一起收掉 —— 否则杀掉 shell,后台的还活着。
      detached: true,
    });

    /**
     * 杀掉**整组**,不是那一个 shell。
     *
     * 这条命令背后的坑是真的踩过:worker 用 `python3 -m server.app &` 起了个
     * 测试服务,那个进程继承了 stdout/stderr 两个管道。Node 的 'close' 事件
     * 要所有持有管道的人退出才触发,于是**永远不触发**,runCommand 的 Promise
     * 永不 settle —— 没有超时、没有报错、进程 idle、一次运行就这么静悄悄地
     * 挂死七个多小时,还留下四个孤儿服务占着端口。
     */
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组可能已经没了
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
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

    // shell 一退出就收掉整组:它可能留了后台进程攥着管道,
    // 不收的话 'close' 永远不来。
    child.on("exit", () => killGroup());

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
