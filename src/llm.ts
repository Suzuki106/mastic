import type { Config } from "./config.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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
  /** 服务端没返回用量时为 null。 */
  usage: Usage | null;
}

/** 流式响应里一条 SSE data 行的形状(只取用得到的字段)。 */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: Usage;
}

interface ErrorBody {
  error?: { message?: string };
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
 * 返回完整回复,方便调用方存进上下文。
 */
export async function streamChat(
  config: Config,
  messages: Message[],
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(describeFailure(response.status, await response.text()));
  }
  if (!response.body) {
    throw new Error("响应没有 body,无法读取流。");
  }

  let reply = "";
  let usage: Usage | null = null;

  for await (const line of readLines(response.body)) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") break;
    if (!payload) continue;

    const chunk = JSON.parse(payload) as StreamChunk;
    // 用量只在收尾的 chunk 上出现一次,一路覆盖留下最后那个
    if (chunk.usage) usage = chunk.usage;

    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      reply += delta;
      onDelta(delta);
    }
  }

  return { reply, usage };
}
