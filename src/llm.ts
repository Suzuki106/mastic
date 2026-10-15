import type { Config } from "./config.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 喂给模型的工具声明。 */
export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * 一条消息在上下文里占的文本量。
 * assistant 发起工具调用的那一轮 content 可能是 null,占用落在 tool_calls 上,
 * 所以两边都要算 —— 压缩靠这个数切边界。
 */
export function contentLength(message: Message): number {
  const own = message.content?.length ?? 0;
  if (message.role !== "assistant" || !message.tool_calls) return own;

  return message.tool_calls.reduce(
    (sum, call) => sum + call.function.name.length + call.function.arguments.length,
    own,
  );
}

/** /chat/completions 的用量统计。各家 OpenAI 兼容实现的字段并不一致,
 *  所以除了三个基本项,其余一律按可选处理,缺了就按 0 记。 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatResult {
  reply: string;
  /** 模型这一轮要求调用的工具,可能一次要好几个。 */
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** 服务端没返回用量时为 null。 */
  usage: Usage | null;
}

/** 流式响应里一条 SSE data 行的形状(只取用得到的字段)。 */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
}

interface ErrorBody {
  error?: { message?: string };
}

export interface StreamOptions {
  onDelta?: (text: string) => void;
  tools?: ToolSchema[];
}

/** 把字节流按行切开 —— SSE 的一个事件可能被拆在多个 chunk 里。 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }

  if (buffer) yield buffer;
}

function describeFailure(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as ErrorBody;
    const message = parsed.error?.message;
    if (message) return `HTTP ${status} — ${message}`;
  } catch {
    // 不是 JSON,退回原始文本
  }
  return `HTTP ${status} — ${raw.slice(0, 300)}`;
}

/**
 * 以 OpenAI 格式调用 /chat/completions,边收边把增量文本交给 onDelta。
 *
 * 工具调用的参数是**一个片段一个片段**流过来的(实测 `{"city": "杭州"}` 这种
 * 短参数会拆成十几个 delta),所以必须按 index 累加拼装;流没结束时参数是不完整的,
 * 不能边收边执行。
 */
export async function streamChat(
  config: Config,
  messages: Message[],
  options: StreamOptions = {},
): Promise<ChatResult> {
  // 空闲超时:每收到一行就把闸门往后推。卡住的连接不会自己报错,
  // 没有这道闸,一次断流就能让整轮 run 永久挂在那里。
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), config.requestIdleTimeoutMs);
  };

  let response: Response;
  try {
    armIdleTimer();
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        ...(options.tools?.length ? { tools: options.tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (controller.signal.aborted) {
      throw new Error(`连接 ${config.requestIdleTimeoutMs}ms 没吐出任何东西,判定断流,已中止。`);
    }
    throw error;
  }

  if (!response.ok) {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    throw new Error(describeFailure(response.status, await response.text()));
  }
  if (!response.body) {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    throw new Error("响应没有 body,无法读取流。");
  }

  let reply = "";
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  const pending = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    for await (const line of readLines(response.body)) {
      armIdleTimer();
      if (!line.startsWith("data:")) continue;

      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") break;
      if (!payload) continue;

      const chunk = JSON.parse(payload) as StreamChunk;
      // 用量只在收尾的 chunk 上出现一次,一路覆盖留下最后那个
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const delta = choice?.delta;
      if (!delta) continue;

      if (delta.content) {
        reply += delta.content;
        options.onDelta?.(delta.content);
      }

      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const call = pending.get(index) ?? { id: "", name: "", arguments: "" };

        // 首片段带 id/name,后续片段只续 arguments
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name = fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;

        pending.set(index, call);
      }
    }
  } catch (error) {
    // 流中途断掉时,把已经拼好的部分丢掉、报清楚原因 —— 半截的工具调用
    // 比直接失败更危险,它会被当成完整的调用来执行。
    if (controller.signal.aborted) {
      throw new Error(`流读到一半断了(${config.requestIdleTimeoutMs}ms 没有新内容),已中止。`);
    }
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }

  const toolCalls: ToolCall[] = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));

  return { reply, toolCalls, finishReason, usage };
}
