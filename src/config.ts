export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** agent 动手的目录。任务书里的相对路径、验收命令的 cwd 都相对它。 */
  workspace: string;
  /** 同时跑几个 worker。任务树里互不依赖的节点按这个上限并行。 */
  concurrency: number;
  /** 被 verifier 判 contradicted 之后,最多重派几次。 */
  maxRetries: number;
  /** 单个 worker 一轮最多几次工具往返 —— 防模型无限往下钻。 */
  maxSteps: number;
  /** 跑验收命令 / 重放证据的超时(毫秒)。 */
  commandTimeoutMs: number;
  /**
   * 模型流多久没有新内容就判连接死了(毫秒)。
   *
   * 是**空闲**超时不是总时长超时 —— 长回答本来就该慢慢吐,卡死的是那种
   * 一个字节都不再来的连接。没有这道闸,一次断流就能让 mastic run 永久挂住。
   */
  requestIdleTimeoutMs: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

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

export function loadConfig(overrides: Partial<Config> = {}): Config {
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
    workspace: optional("MASTIC_WORKSPACE") ?? process.cwd(),
    concurrency: positiveInt("MASTIC_CONCURRENCY", 3),
    maxRetries: positiveInt("MASTIC_MAX_RETRIES", 2),
    maxSteps: positiveInt("MASTIC_MAX_STEPS", 24),
    commandTimeoutMs: positiveInt("MASTIC_COMMAND_TIMEOUT_MS", 300_000),
    requestIdleTimeoutMs: positiveInt("MASTIC_REQUEST_IDLE_TIMEOUT_MS", 120_000),
    ...overrides,
  };
}
