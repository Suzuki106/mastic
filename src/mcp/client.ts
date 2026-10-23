import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * MCP 服务的最小 stdio 客户端。
 *
 * 只实现了 mastic 真正需要的那三个方法:`initialize` / `tools/list` / `tools/call`。
 * 这不是一个通用 MCP SDK —— 它不维护会话状态、不管提示词、不管资源订阅。
 * 多出来的能力会被写进配置却永远不生效,那比没有更糟。
 *
 * 协议走 stdio 上的**按行分隔 JSON**(MCP 的 stdio 传输就是这样),一条消息一行。
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 相对工作目录,省略则用 mastic 自己的工作目录。 */
  cwd?: string;
  disabled?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri?: string;
  text?: string;
  mimeType?: string;
  blob?: string;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: McpResource;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpClientOptions {
  /** 单条请求(initialize / tools/list)的超时。 */
  requestTimeoutMs?: number;
  /** tools/call 的超时。工具跑得久是常事,默认比控制消息宽。 */
  callTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_CALL_TIMEOUT = 300_000;
const STDERR_TAIL = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpClient {
  readonly name: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();

  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private closed = false;

  constructor(name: string, config: McpServerConfig, options: McpClientOptions = {}) {
    this.name = name;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT;

    this.child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      // 单独成组,关的时候能连它派生的子进程一起收掉 ——
      // 否则 `npx xxx` 那种外壳一杀,真正的服务进程会变成孤儿。
      detached: true,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });

    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });

    this.child.on("error", (error: Error) => {
      this.fail(`起不来:${error.message}`);
    });

    this.child.on("exit", (code: number | null, signal: string | null) => {
      this.fail(`进程退出了(code ${code ?? "?"}, signal ${signal ?? "?"})`);
    });
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;

      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "") this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // 服务端往 stdout 打日志是常见的不合规行为 —— 忽略,不要因为一行噪音断掉整个连接
      return;
    }
    if (!isRecord(message)) return;

    const id = message.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (message.error !== undefined) {
        pending.reject(new Error(this.describeError(message.error)));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    // 服务端发起的请求(比如 roots/list)。mastic 不支持任何一项,
    // 必须明确回一个错误,否则服务端会一直等。
    if (typeof id === "string" && typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "mastic 不支持服务端发起的请求" },
      });
    }

    // 没有 id 的是通知(notifications/*),按协议可以不管
  }

  private describeError(error: unknown): string {
    if (isRecord(error)) {
      const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
      const code = typeof error.code === "number" ? ` (${error.code})` : "";
      return `${message}${code}`;
    }
    return String(error);
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim();
    return tail === "" ? "" : `\n服务端 stderr 末尾:\n${tail}`;
  }

  private write(message: unknown): void {
    if (this.child.stdin.destroyed) {
      throw new Error(`MCP 服务 ${this.name} 的 stdin 已经关了${this.stderrHint()}`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP 服务 ${this.name} 已经关闭${this.stderrHint()}`));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 服务 ${this.name} 在 ${timeoutMs}ms 内没回应 \`${method}\`${this.stderrHint()}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // 通知丢了不影响协议正确性 —— 服务端不需要回执
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP 服务 ${this.name} ${reason}${this.stderrHint()}`));
    }
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mastic", version: "0.1.0" },
      },
      this.requestTimeoutMs,
    );
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    // 分页。绝大多数服务一页就完了,但协议允许 nextCursor,不处理会静默丢工具。
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        this.requestTimeoutMs,
      );

      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new Error(`MCP 服务 ${this.name} 的 tools/list 返回格式不对`);
      }

      for (const item of result.tools) {
        if (!isRecord(item) || typeof item.name !== "string") continue;
        tools.push({
          name: item.name,
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
        });
      }

      const next = result.nextCursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, this.callTimeoutMs);

    if (!isRecord(result)) {
      throw new Error(`MCP 服务 ${this.name} 的 tools/call 返回格式不对`);
    }

    const content: McpContentBlock[] = [];
    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (!isRecord(item) || typeof item.type !== "string") continue;
        content.push({
          type: item.type,
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.data === "string" ? { data: item.data } : {}),
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(isRecord(item.resource) ? { resource: item.resource } : {}),
        });
      }
    }

    return { content, isError: result.isError === true };
  }

  close(): void {
    if (this.closed) {
      // 进程可能还活着(比如 fail 之后),照样要收
      this.kill();
      return;
    }

    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP 服务 ${this.name} 被关闭了`));
    }
    this.pending.clear();

    try {
      this.child.stdin.end();
    } catch {
      // 已经断了就算了
    }
    this.kill();
  }

  private kill(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;

    // 先好好说再见,给它一点收尾时间;不走就强杀。
    // detached 让 pid 同时是进程组号,SIGTERM 发给 -pid 能连子进程一起收。
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // 已经没了
      }
    }

    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 已经没了
      }
    }, 2_000);
    timer.unref();
  }
}
