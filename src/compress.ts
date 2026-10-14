import type { Config } from "./config.ts";
import { streamChat, type Message } from "./llm.ts";

/** 摘要指令。摘要长度不设硬上限,靠这里的要求来约束。 */
const SUMMARY_PROMPT = `你是对话压缩器。把给你的对话记录压缩成一份摘要。

必须保留:
- 已确认的事实与结论
- 做过的决定,以及当时的理由
- 约束条件、限制、偏好
- 未解决的问题和待办事项
- 关键标识符:文件名、函数名、报错原文、数字、URL

可以丢弃:
- 寒暄与客套
- 重复表述
- 已经作废的中间尝试

写法要求:
- 用陈述句,按主题组织,不要按时间写成流水账
- 不要写成对话形式(不要出现"用户说""助手说")
- 只依据原文,不要推测或补充原文里没有的信息
- 直接输出摘要正文,不要开场白也不要结束语

特别注意:
输入里可能已经包含一份更早生成的摘要(通常以"以下是更早对话的摘要"开头)。
那不是原始对话,是上一轮压缩的产物。你必须把它承载的信息一并融入新摘要,
既不要丢失它记录的内容,也不要照抄它的措辞 —— 最终只输出一份统一的摘要。`;

export interface Split {
  /** 原样保留的消息(含最近的部分)。 */
  keep: Message[];
  /** 要被折叠成摘要的消息。 */
  fold: Message[];
}

/**
 * 从最新往回找保留区。
 *
 * totalTokens 是这一轮真实的 prompt_tokens,拿它把「token 预算」换算成「字符占比」——
 * 于是不必引 tokenizer,只用两个精确量:API 给的 token 数 + 本地算的字符数。
 */
export function splitForCompaction(
  messages: Message[],
  keepRecentTokens: number,
  totalTokens: number,
): Split {
  // messages[0] 是人设,永远不进压缩,也不参与这里的计算
  const body = messages.slice(1);
  if (body.length === 0) return { keep: [], fold: [] };

  const chars = body.map((m) => m.content.length);
  const totalChars = chars.reduce((sum, n) => sum + n, 0);

  if (totalChars === 0 || totalTokens <= 0 || keepRecentTokens >= totalTokens) {
    return { keep: body, fold: [] };
  }

  const budgetChars = (totalChars * keepRecentTokens) / totalTokens;

  let cut = 0;
  let accumulated = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    accumulated += chars[i] ?? 0;
    cut = i;
    // 向上取整:跨过预算的那一条也算进保留区,所以是 >= 而不是 >
    if (accumulated >= budgetChars) break;
  }

  // 保留区不要以 assistant 开头,否则开头是一段没有来由的模型独白。
  // 往前多吃一条 —— 对话是交替的,再往前那条就是 user。
  if (cut > 0 && body[cut]?.role === "assistant") cut -= 1;

  return { keep: body.slice(cut), fold: body.slice(0, cut) };
}

function transcript(messages: Message[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

/** 把待折叠的部分交给模型做摘要,返回摘要正文。 */
export async function summarise(config: Config, fold: Message[]): Promise<string> {
  const { reply } = await streamChat(
    config,
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: transcript(fold) },
    ],
    () => {},
  );
  return reply.trim();
}

/**
 * 就地把 messages 换成 [人设, 摘要, ...保留区]。
 * 返回这次折叠了多少条、保留了多少条,供调用方提示用。
 */
export function applySummary(messages: Message[], summary: string, keep: Message[]): void {
  const persona = messages[0];
  if (!persona) return;

  messages.length = 0;
  messages.push(
    persona,
    { role: "system", content: `以下是更早对话的摘要:\n\n${summary}` },
    ...keep,
  );
}
