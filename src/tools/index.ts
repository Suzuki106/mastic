import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recordCommand, recordFile, type Ledger } from "../ledger.ts";
import { runCommand, sha256Text } from "../exec.ts";
import type { ToolSchema } from "../llm.ts";
import { displayPath, resolveInside } from "../paths.ts";
import { looksLikeDataFile } from "../provenance.ts";
import { webTools } from "./web.ts";

export interface ToolContext {
  workspace: string;
  /** 本次运行的目录。抓下来的数据、溯源链都落在这儿 —— 不在工作区里。 */
  runRoot: string;
  ledger: Ledger;
  timeoutMs: number;
  /** 一次工具调用最多回灌多少字符 —— 返回一大坨会当场炸掉上下文。 */
  maxOutputChars: number;
}

export interface Tool {
  schema: ToolSchema;
  /**
   * args 是模型给的,不可信 —— 实现里必须自己校验类型。
   * 抛出的错误会被上层转成一条 tool 消息回灌,不会冒泡出去。
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${key}\` 必须是非空字符串`);
  }
  return value;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(已截断,原文 ${text.length} 字符)`;
}

const readFileTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取工作目录内的一个文本文件。返回内容,并在证据台账里记一条 F 编号 —— " +
        "想用这个文件当证据,就在报告里引用那个编号。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的路径。" } },
        required: ["path"],
      },
    },
  },

  async run(args, ctx) {
    const path = requiredString(args, "path");
    const full = resolveInside(ctx.workspace, path);
    const content = await readFile(full, "utf8");
    const entry = recordFile(ctx.ledger, {
      path: displayPath(ctx.workspace, full),
      sha256: sha256Text(content),
      action: "read",
    });

    return `${entry.id} | ${entry.path} (${content.length} 字节)\n--- 内容 ---\n${clip(content, ctx.maxOutputChars)}`;
  },
};

const writeFileTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "写入工作目录内的一个文件(整份覆盖,目录会自动创建)。" +
        "返回一个 F 编号 —— 报告里要说「我改了这个文件」,就引用它。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的路径。" },
          content: { type: "string", description: "文件的完整新内容。" },
        },
        required: ["path", "content"],
      },
    },
  },

  async run(args, ctx) {
    const path = requiredString(args, "path");
    const content = requiredString(args, "content");
    const full = resolveInside(ctx.workspace, path);

    // **数据文件不能用这个工具写。**
    //
    // `write_file` 的内容来自模型 —— 拿它写一份 csv/jsonl,就等于凭空造了
    // 一份"实验数据",而实验会因此什么都没测。这是造假最省事的路径,堵在这里。
    //
    // 数据要么用 fetch_url 从外部取,要么让代码算出来(跑脚本产出)。
    // 配置、代码、笔记不受影响 —— 那些本来就不该被要求证明来源。
    if (looksLikeDataFile(path)) {
      throw new Error(
        `\`${path}\` 是数据文件,不能用 write_file 直接写 —— 内容来自模型,不是一份有来源的数据。\n` +
          `  要真实数据:用 fetch_url 从外部抓,或让用户提供。\n` +
          `  要实验结果:写代码去算,用 run_bash 跑出来。`,
      );
    }

    // 写之前先看它在不在 —— files_changed 里的 created / modified 由这个决定
    let existed = true;
    try {
      await stat(full);
    } catch {
      existed = false;
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");

    const entry = recordFile(ctx.ledger, {
      path: displayPath(ctx.workspace, full),
      sha256: sha256Text(content),
      action: "written",
      existed,
    });

    return `${entry.id} | 已写入 ${entry.path} (${content.length} 字节,sha256 ${entry.sha256.slice(0, 12)}…)`;
  },
};

const listDirTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出一个目录下的条目。不产生证据。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的路径,省略则为根。" },
        },
        required: [],
      },
    },
  },

  async run(args, ctx) {
    const raw = args.path;
    if (raw !== undefined && typeof raw !== "string") {
      throw new Error("`path` 必须是字符串");
    }

    const full = resolveInside(ctx.workspace, raw ?? ".");
    const entries = await readdir(full, { withFileTypes: true });

    if (entries.length === 0) return `${displayPath(ctx.workspace, full)} 是空目录`;

    const lines = entries
      .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
      .sort();

    return clip(lines.join("\n"), ctx.maxOutputChars);
  },
};

const runBashTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "在工作目录里跑一条 shell 命令。返回退出码、stdout、stderr,并记一条 C 编号 —— " +
        "这是**唯一**能拿来证明「我验证过了」的东西。命令要尽量确定(别带时间戳),否则重放会对不上。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的完整命令。" },
          cwd: { type: "string", description: "相对工作目录的运行目录,省略则为根。" },
        },
        required: ["command"],
      },
    },
  },

  async run(args, ctx) {
    const command = requiredString(args, "command");
    const rawCwd = args.cwd;
    if (rawCwd !== undefined && typeof rawCwd !== "string") {
      throw new Error("`cwd` 必须是字符串");
    }

    const cwd = resolveInside(ctx.workspace, rawCwd ?? ".");
    const result = await runCommand(command, { cwd, timeoutMs: ctx.timeoutMs });

    const entry = recordCommand(ctx.ledger, {
      run: command,
      cwd: displayPath(ctx.workspace, cwd),
      exitCode: result.exitCode,
      stdoutSha256: result.stdoutSha256,
      stdoutBytes: result.stdoutBytes,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });

    const parts = [`${entry.id} | 退出码 ${result.exitCode} | ${result.durationMs}ms`];
    if (result.timedOut) parts.push(`(超时被强杀)`);
    if (result.stdout) parts.push(`--- stdout ---\n${clip(result.stdout, ctx.maxOutputChars)}`);
    if (result.stderr) parts.push(`--- stderr ---\n${clip(result.stderr, ctx.maxOutputChars / 2)}`);
    if (!result.stdout && !result.stderr) parts.push("(没有任何输出)");

    return parts.join("\n");
  },
};

export const workerTools: readonly Tool[] = [readFileTool, writeFileTool, listDirTool, runBashTool, ...webTools];

/** 只能看、不能改 —— planner 摸现场用。给它 bash 等于让它提前动手。 */
// planner 也要联网 —— 它得先找得到真实数据源,才能写得出引用它的任务书
export const discoveryTools: readonly Tool[] = [readFileTool, listDirTool, ...webTools];

export function toolSchemas(tools: readonly Tool[]): ToolSchema[] {
  return tools.map((tool) => tool.schema);
}

export function findTool(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.schema.function.name === name);
}
