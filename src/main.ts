import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { createAudit } from "./audit.ts";
import { applySummary, splitForCompaction, summarise } from "./compress.ts";
import { loadConfig, type Config } from "./config.ts";
import { streamChat, type Message } from "./llm.ts";

const PROMPT = "你 > ";
const HELP = "输入后回车对话;/clear 清空上下文,/exit 退出。";

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

async function main(): Promise<void> {
  const config = loadConfig();
  const messages: Message[] = [{ role: "system", content: config.systemPrompt }];
  const audit = createAudit();

  console.log(`模型   ${config.model}`);
  console.log(`接口   ${config.baseUrl}`);
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

      messages.push({ role: "user", content: input });
      stdout.write("AI > ");

      try {
        const { reply, usage } = await streamChat(config, messages, (delta) => stdout.write(delta));
        messages.push({ role: "assistant", content: reply });

        stdout.write("\n");
        console.log(usage ? audit.add(usage) : "─ tokens  (服务端未返回 usage,本轮无法结算)");

        // 阈值判定用的是这一轮真实的 prompt_tokens,不是估算
        if (usage && (usage.prompt_tokens ?? 0) >= config.compactAt) {
          stdout.write("\n");
          await compactIfFull(config, messages, usage.prompt_tokens ?? 0);
        }
      } catch (error) {
        // 这一轮没成功,别把半截对话留在上下文里
        messages.pop();
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
