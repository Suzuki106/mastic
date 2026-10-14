import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { streamChat, type Message } from "./llm.ts";

const PROMPT = "你 > ";
const HELP = "输入后回车对话;/clear 清空上下文,/exit 退出。";

async function main(): Promise<void> {
  const config = loadConfig();
  const messages: Message[] = [{ role: "system", content: config.systemPrompt }];

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
        const reply = await streamChat(config, messages, (delta) => stdout.write(delta));
        messages.push({ role: "assistant", content: reply });
      } catch (error) {
        // 这一轮没成功,别把半截对话留在上下文里
        messages.pop();
        console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
      }

      stdout.write(`\n\n${PROMPT}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
