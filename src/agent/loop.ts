import type { Config } from "../config.ts";
import {
  streamChat,
  type ChatResult,
  type ContentPart,
  type Message,
  type StreamOptions,
  type ToolSchema,
  type Usage,
} from "../llm.ts";
import { findTool, toolSchemas, type Tool, type ToolContext } from "../tools/index.ts";

/**
 * 发一次请求拿一次回复。
 *
 * 单独抽成一个可替换的入口,是为了让这个循环能被离线测到 ——
 * 步数用尽、打回重交、卡住判定这些行为全在这里,而它们恰恰是最该被测的。
 */
export type ChatFn = (config: Config, messages: Message[], options?: StreamOptions) => Promise<ChatResult>;

export type LoopEventKind = "assistant" | "tool" | "rejected" | "stopped";

export interface LoopEvent {
  kind: LoopEventKind;
  detail: string;
}

export interface ToolLoopOptions {
  config: Config;
  system: string;
  /** 带上图片时是内容块数组,平时就是一句话。 */
  user: string | ContentPart[];
  tools: readonly Tool[];
  toolContext: ToolContext;
  /** 终止工具的名字。模型调用它 = 交卷。 */
  terminalTool: string;
  /**
   * 收到终止工具的参数时调用。
   *
   * 返回字符串 = **打回**:这段文字当作那次工具调用的结果回灌,循环继续。
   * 返回 undefined = 收下,循环结束。
   *
   * 校验失败就是靠这个退回给模型的 —— 格式不对不改到对为止,而不是收下一份坏文档。
   */
  onTerminal: (args: Record<string, unknown>) => string | undefined;
  maxSteps: number;
  onEvent?: (event: LoopEvent) => void;
  /** 测试用。默认就是真的 streamChat。 */
  chat?: ChatFn;
}

export interface ToolLoopResult {
  /** 终止工具收到的参数;没交卷就是 null。 */
  terminalArgs: Record<string, unknown> | null;
  status: "submitted" | "steps";
  usage: Usage | null;
}

function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total;
  if (total === null) return { ...next };

  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

  const merged: Usage = {
    prompt_tokens: sum(total.prompt_tokens, next.prompt_tokens),
    completion_tokens: sum(total.completion_tokens, next.completion_tokens),
    total_tokens: sum(total.total_tokens, next.total_tokens),
  };

  const hit = sum(total.prompt_cache_hit_tokens, next.prompt_cache_hit_tokens);
  if (hit !== undefined) merged.prompt_cache_hit_tokens = hit;

  return merged;
}

function signatureOf(calls: { function: { name: string; arguments: string } }[]): string {
  return calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(" | ");
}

function preview(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 请求 → 有工具就执行再请求 → 直到模型调用终止工具。
 *
 * "任务完成"没有通用判据,所以这里也不假装有:唯一的正常出口是模型主动交卷,
 * 另外一个是步数用尽 —— 那是守卫在说「这个信号不可信」,不是在说「做完了」。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const messages: Message[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];

  const schemas: ToolSchema[] = toolSchemas(options.tools);
  let steps = 0;
  let usage: Usage | null = null;
  let previousSignature = "";
  let finalRound = false;

  for (;;) {
    if (steps >= options.maxSteps) {
      if (finalRound) {
        options.onEvent?.({ kind: "stopped", detail: `用满 ${options.maxSteps} 步也没交卷` });
        return { terminalArgs: null, status: "steps", usage };
      }

      // 步数用尽不该什么都不留下。再给一轮,专门用来交卷 ——
      // 否则一次"没跑完"会把已经做的工作全丢掉,而重试是从头再来一遍,
      // 同一个任务永远卡在同样的步数上。
      //
      // 注意这里**不能 continue** —— 回到循环顶会再撞上这个判断,
      // 那一轮就永远轮不到发请求。直接落到下面的 chat 调用。
      finalRound = true;
      options.onEvent?.({ kind: "stopped", detail: `已用满 ${options.maxSteps} 步,要它交卷` });
      messages.push({
        role: "user",
        content:
          `步数已经用尽,不要再做任何调查或修改。\n\n` +
          `现在立刻调用 \`${options.terminalTool}\` 交卷:\n` +
          `- 已经做成的,写进 claims,带上证据引用;\n` +
          `- 没做完的,原样写进 unresolved;\n` +
          `- 如果整件事做不下去,写 blocked 并说明卡在哪。\n\n` +
          `交一份不完整的报告是可以接受的;什么都不交不可以。`,
      });
    }

    const chat = options.chat ?? streamChat;
    const { reply, toolCalls, usage: turnUsage } = await chat(options.config, messages, {
      tools: schemas,
    });
    usage = addUsage(usage, turnUsage);

    if (reply.trim() !== "") {
      options.onEvent?.({ kind: "assistant", detail: preview(reply) });
    }

    // 模型不调工具就停了 —— 它没交卷。把这句话怼回去,而不是当成"做完了"。
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: reply });
      messages.push({
        role: "user",
        content: `你还没有调用 \`${options.terminalTool}\`。要说的话写进报告里,然后用那个工具交卷。`,
      });
      steps += 1;
      continue;
    }

    // 同一组调用连着来两次 = 卡住。此时**不能**把这条 assistant 推进去 ——
    // 它带着 tool_calls 却没有对应的 tool 响应,下一次请求会被直接拒绝。
    const signature = signatureOf(toolCalls);
    if (signature === previousSignature) {
      options.onEvent?.({ kind: "stopped", detail: "模型在重复同一组调用,判定卡住" });
      return { terminalArgs: null, status: "steps", usage };
    }
    previousSignature = signature;
    steps += 1;

    messages.push({
      role: "assistant",
      content: reply.trim() === "" ? null : reply,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function.name;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        messages.push({ role: "tool", tool_call_id: call.id, content: `错误:参数不是合法 JSON(${detail})` });
        continue;
      }

      if (name === options.terminalTool) {
        const rejection = options.onTerminal(args);

        if (rejection === undefined) {
          options.onEvent?.({ kind: "assistant", detail: "已交卷" });
          return { terminalArgs: args, status: "submitted", usage };
        }

        options.onEvent?.({ kind: "rejected", detail: preview(rejection) });
        messages.push({ role: "tool", tool_call_id: call.id, content: rejection });
        continue;
      }

      const tool = findTool(options.tools, name);
      if (tool === undefined) {
        messages.push({ role: "tool", tool_call_id: call.id, content: `错误:没有名为 ${name} 的工具。` });
        continue;
      }

      try {
        const output = await tool.run(args, options.toolContext);
        options.onEvent?.({ kind: "tool", detail: `${name} → ${preview(output, 160)}` });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      } catch (error) {
        // 工具失败远没有循环挂掉严重 —— 变成文本交回去让它自己想办法
        const detail = error instanceof Error ? error.message : String(error);
        options.onEvent?.({ kind: "tool", detail: `${name} 失败:${detail}` });
        messages.push({ role: "tool", tool_call_id: call.id, content: `错误:${detail}` });
      }
    }
  }
}
