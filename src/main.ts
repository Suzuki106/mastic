import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { createAudit, mergeUsage } from "./audit.ts";
import { applySummary, splitForCompaction, summarise } from "./compress.ts";
import { loadConfig, type Config } from "./config.ts";
import { streamChat, type Message, type ToolCall, type Usage } from "./llm.ts";
import { registry, toolSchemas } from "./tools.ts";

const PROMPT = "你 > ";
const HELP = "输入后回车对话;/clear 清空上下文,/exit 退出。";

/** 一个用户轮次里最多几次工具往返 —— 防模型无限往下钻。 */
const MAX_STEPS = 8;
/** 工具输出上限(字符)。工具返回一大坨会当场炸掉上下文。 */
const MAX_TOOL_OUTPUT = 4000;

/** 上下文过阈值时压一次。就地改 messages。 */
async function compactIfFull(
  config: Config,
  messages: Message[],
  promptTokens: number,
): Promise<void> {
  const { keep, fold } = splitForCompaction(messages, config.keepRecent, promptTokens);

  if (fold.length === 0) {
    console.log(`(上下文 ${promptTokens} 已到阈值 ${config.compactAt},但没有可折叠的内容,跳过)`);
    return;
  }

  console.log(
    `(上下文 ${promptTokens} ≥ ${config.compactAt},压缩中:折叠 ${fold.length} 条,保留 ${keep.length} 条…)`,
  );

  const startedAt = Date.now();
  const summary = await summarise(config, fold);

  if (!summary) {
    // 宁可保持原样,也不能拿一个空摘要换掉真实上下文
    console.log("(摘要为空,放弃压缩,上下文保持原样)");
    return;
  }

  applySummary(messages, summary, keep);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`(压缩完成,耗时 ${seconds}s;压缩后的真实大小要等下一轮的 tokens 行)`);
}

/**
 * 执行一个工具,返回要回灌的文本。
 * 任何失败都变成文本交回去,绝不让异常冒泡 —— 工具失败远没有循环挂掉严重。
 */
async function runTool(call: ToolCall): Promise<string> {
  const tool = registry[call.function.name];
  if (!tool) return `错误:没有名为 ${call.function.name} 的工具。`;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `错误:参数不是合法 JSON(${detail})`;
  }

  try {
    const output = await tool.run(args);
    return output.length > MAX_TOOL_OUTPUT
      ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n…(输出被截断,原始长度 ${output.length} 字符)`
      : output;
  } catch (error) {
    return `错误:${error instanceof Error ? error.message : String(error)}`;
  }
}

function callSignature(calls: ToolCall[]): string {
  return calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(" | ");
}

type StopReason = "done" | "steps" | "stuck";

interface TurnOutcome {
  reason: StopReason;
  usages: Usage[];
  /** 最后一跳的 prompt_tokens,拿它判是否该压缩。 */
  lastPromptTokens: number;
}

/**
 * 跑完一个用户轮次:请求 → 有工具就执行再请求 → 直到模型不再要工具。
 *
 * "任务完成"没有通用判据,所以这里不假装有:正常出口只有"模型不再调用工具"
 * (finish_reason 变成 stop),其余两个出口都是守卫,是在说这个信号不可信。
 */
async function runTurn(config: Config, messages: Message[]): Promise<TurnOutcome> {
  const usages: Usage[] = [];
  let lastPromptTokens = 0;
  let steps = 0;
  let previousSignature = "";
  let reason: StopReason = "done";

  for (;;) {
    if (steps >= MAX_STEPS) {
      reason = "steps";
      break;
    }

    stdout.write("AI > ");
    const { reply, toolCalls, usage } = await streamChat(config, messages, {
      onDelta: (delta) => stdout.write(delta),
      tools: toolSchemas(),
    });
    stdout.write("\n");

    if (usage) {
      usages.push(usage);
      lastPromptTokens = usage.prompt_tokens ?? lastPromptTokens;
    }

    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: reply });
      break; // 正常出口
    }

    // 卡住就直接停,此时**不能**把这条 assistant 推进去 ——
    // 它带着 tool_calls 却没有对应的 tool 响应,下一次请求会被直接拒绝。
    const signature = callSignature(toolCalls);
    if (signature === previousSignature) {
      reason = "stuck";
      break;
    }
    previousSignature = signature;
    steps += 1;

    messages.push({
      role: "assistant",
      content: reply.length > 0 ? reply : null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      stdout.write(`  → ${call.function.name}(${call.function.arguments})\n`);
      const result = await runTool(call);
      stdout.write(`    ${result.split("\n")[0] ?? ""}\n`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return { reason, usages, lastPromptTokens };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const messages: Message[] = [{ role: "system", content: config.systemPrompt }];
  const audit = createAudit();

  console.log(`模型   ${config.model}`);
  console.log(`接口   ${config.baseUrl}`);
  console.log(`工具   ${Object.keys(registry).join(", ") || "(无)"}`);
  console.log(HELP + "\n");

  // 用异步迭代而不是 rl.question():管道输入时 stdin 会在请求还没回来时就 EOF,
  // question() 会抛 "readline was closed",导致只跑得动第一轮。迭代器会把
  // 已到达但还没处理的行缓冲住。
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    stdout.write(PROMPT);

    for await (const line of rl) {
      const input = line.trim();

      if (input === "/exit") break;
      if (input === "/clear") {
        messages.length = 1;
        console.log("(上下文已清空)\n");
        stdout.write(PROMPT);
        continue;
      }
      if (!input) {
        stdout.write(PROMPT);
        continue;
      }

      const before = messages.length;
      messages.push({ role: "user", content: input });

      try {
        const outcome = await runTurn(config, messages);

        console.log(
          outcome.usages.length > 0
            ? audit.add(mergeUsage(outcome.usages))
            : "─ tokens  (服务端未返回 usage,本轮无法结算)",
        );

        if (outcome.reason === "steps") {
          console.log(`(已到单轮工具往返上限 ${MAX_STEPS},停止;以上是当前进展)`);
        }
        if (outcome.reason === "stuck") {
          console.log("(模型在重复同一组工具调用,判定卡住,停止)");
        }

        // 阈值判定用的是真实 prompt_tokens,不是估算
        if (outcome.lastPromptTokens >= config.compactAt) {
          stdout.write("\n");
          await compactIfFull(config, messages, outcome.lastPromptTokens);
        }
      } catch (error) {
        // 整轮回滚到用户输入之前,别在上下文里留半截工具调用
        messages.length = before;
        console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
      }

      stdout.write(`\n${PROMPT}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
