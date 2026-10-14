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

/**
 * 一个用户轮次可能触发 N 次请求(工具循环),账本按轮次汇总、而不是按请求,
 * 否则一次提问会在屏幕上跳出好几行 tokens。
 */
export function mergeUsage(usages: Usage[]): Usage {
  const sum = (pick: (u: Usage) => number | undefined): number =>
    usages.reduce((total, u) => total + (pick(u) ?? 0), 0);

  // 只有确实有输入提供过这个字段才写值。全都没有就留 undefined ——
  // 写成 0 会被 read() 里的 `a ?? b` 当成"服务端说了 0",把另一路缓存字段盖掉。
  const sumIfPresent = (pick: (u: Usage) => number | undefined): number | undefined => {
    const present = usages.filter((u) => pick(u) !== undefined);
    return present.length === 0 ? undefined : present.reduce((t, u) => t + (pick(u) ?? 0), 0);
  };

  const merged: Usage = {
    prompt_tokens: sum((u) => u.prompt_tokens),
    completion_tokens: sum((u) => u.completion_tokens),
    total_tokens: sum((u) => u.total_tokens),
  };

  const hit = sumIfPresent((u) => u.prompt_cache_hit_tokens);
  if (hit !== undefined) merged.prompt_cache_hit_tokens = hit;

  const cached = sumIfPresent((u) => u.prompt_tokens_details?.cached_tokens);
  if (cached !== undefined) merged.prompt_tokens_details = { cached_tokens: cached };

  const reasoning = sumIfPresent((u) => u.completion_tokens_details?.reasoning_tokens);
  if (reasoning !== undefined) merged.completion_tokens_details = { reasoning_tokens: reasoning };

  return merged;
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
