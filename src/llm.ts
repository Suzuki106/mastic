import type { Config } from "./config.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 流式响应里一条 SSE data 行的形状(只取用得到的字段)。 */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
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
): Promise<string> {
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

  for await (const line of readLines(response.body)) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") break;
    if (!payload) continue;

    const chunk = JSON.parse(payload) as StreamChunk;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      reply += delta;
      onDelta(delta);
    }
  }

  return reply;
}
