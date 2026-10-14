import type { ToolSchema } from "./llm.ts";

export interface Tool {
  schema: ToolSchema;
  /**
   * args 是模型给的,不可信 —— 实现里必须自己校验类型。
   * 抛出的错误会被上层转成一条 tool 消息回灌给模型,不会冒泡出去。
   */
  run(args: Record<string, unknown>): Promise<string>;
}

const getTime: Tool = {
  schema: {
    type: "function",
    function: {
      name: "get_time",
      description: "查询指定时区的当前日期和时间。不确定用户在哪时,先问清楚再调用。",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "IANA 时区名,例如 Asia/Shanghai、America/New_York。省略则用本机时区。",
          },
        },
        required: [],
      },
    },
  },

  async run(args) {
    const timezone = args.timezone;

    if (timezone !== undefined && typeof timezone !== "string") {
      throw new Error("timezone 必须是字符串");
    }

    try {
      return new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        ...(timezone ? { timeZone: timezone } : {}),
      }).format(new Date());
    } catch {
      throw new Error(`时区 "${String(timezone)}" 无法识别`);
    }
  },
};

/** 单一来源:schema 与实现贴在一起,避免两边悄悄漂移。 */
export const registry: Record<string, Tool> = {
  [getTime.schema.function.name]: getTime,
};

export function toolSchemas(): ToolSchema[] {
  return Object.values(registry).map((tool) => tool.schema);
}
