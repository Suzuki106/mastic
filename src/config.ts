export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** 上下文涨到这么多 token 就压一次。 */
  compactAt: number;
  /** 压缩时原样保留的最近 token 量。 */
  keepRecent: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const DEFAULT_COMPACT_AT = 120_000;
const DEFAULT_KEEP_RECENT = 40_000;

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 得是个正数,收到的是 "${raw}"`);
  }
  return Math.floor(value);
}

export function loadConfig(): Config {
  const apiKey = optional("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "缺少 OPENAI_API_KEY。请复制模板并填好:\n" +
        "  cp .env.example .env\n" +
        "  # 然后编辑 .env,填入你的 API Key",
    );
  }

  const compactAt = positiveInt("COMPACT_AT", DEFAULT_COMPACT_AT);
  const keepRecent = positiveInt("KEEP_RECENT", DEFAULT_KEEP_RECENT);
  if (keepRecent >= compactAt) {
    throw new Error(
      `KEEP_RECENT(${keepRecent})必须小于 COMPACT_AT(${compactAt})——` +
        "否则压完立刻又到阈值,会变成每轮都重压。",
    );
  }

  return {
    apiKey,
    // 去掉结尾斜杠,免得拼出 //chat/completions
    baseUrl: (optional("OPENAI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: optional("OPENAI_MODEL") ?? DEFAULT_MODEL,
    systemPrompt: optional("SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT,
    compactAt,
    keepRecent,
  };
}
