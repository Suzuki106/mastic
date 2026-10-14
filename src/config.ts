export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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

  return {
    apiKey,
    // 去掉结尾斜杠,免得拼出 //chat/completions
    baseUrl: (optional("OPENAI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: optional("OPENAI_MODEL") ?? DEFAULT_MODEL,
    systemPrompt: optional("SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT,
  };
}
