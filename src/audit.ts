import type { Usage } from "./llm.ts";

const num = (value: number | undefined): number => (typeof value === "number" ? value : 0);

interface TurnUsage {
  prompt: number;
  completion: number;
  /** completion 里被计费但没打印出来的思考部分。 */
  reasoning: number;
  /** 命中缓存的输入 token —— 命中部分单价低得多。 */
  cached: number;
  total: number;
}

/** 各家字段不统一,这里做一次收敛:缺字段按 0,绝不能因为某个服务少给一个
 *  字段就把主流程搞挂。缓存命中优先读 DeepSeek 的 prompt_cache_hit_tokens,
 *  没有就退回 OpenAI 的 prompt_tokens_details.cached_tokens。 */
function read(usage: Usage): TurnUsage {
  return {
    prompt: num(usage.prompt_tokens),
    completion: num(usage.completion_tokens),
    reasoning: num(usage.completion_tokens_details?.reasoning_tokens),
    cached: num(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    total: num(usage.total_tokens),
  };
}

export interface AuditTotals {
  turns: number;
  prompt: number;
  completion: number;
  reasoning: number;
  cached: number;
  total: number;
}

export interface Audit {
  /** 记一轮,返回可直接打印的审计行。 */
  add(usage: Usage): string;
  totals(): AuditTotals;
}

export function createAudit(): Audit {
  const running: AuditTotals = {
    turns: 0,
    prompt: 0,
    completion: 0,
    reasoning: 0,
    cached: 0,
    total: 0,
  };

  return {
    add(usage: Usage): string {
      const turn = read(usage);

      running.turns += 1;
      running.prompt += turn.prompt;
      running.completion += turn.completion;
      running.reasoning += turn.reasoning;
      running.cached += turn.cached;
      running.total += turn.total;

      // 思考量非 0 才展开 —— 非推理模型这行会短一些
      const think = turn.reasoning > 0 ? `(思考 ${turn.reasoning} / 可见 ${turn.completion - turn.reasoning})` : "";

      return (
        `─ tokens  入 ${turn.prompt}(缓存 ${turn.cached})` +
        `  出 ${turn.completion}${think}` +
        `  ·  本轮 ${turn.total}  ·  累计 ${running.total}`
      );
    },

    totals(): AuditTotals {
      return { ...running };
    },
  };
}
