/**
 * 手写的字段校验。
 *
 * 不用 zod 是为了让错误消息完全可控:这些消息会被原样回灌给模型让它改文档,
 * 所以每一条都要说清楚「哪个字段、期望什么、实际收到什么」。
 */
export type Problems = string[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把任意值渲染成一句人能看懂的话,用在报错里。 */
export function describe(value: unknown): string {
  if (value === undefined) return "什么都没有";
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(${value.length} 项)`;
  if (typeof value === "object") return "对象";
  if (typeof value === "string") return `字符串 "${value.slice(0, 40)}"`;
  return `${typeof value} ${String(value)}`;
}

interface ReadOptions {
  required?: boolean;
  /** 少了就补这个值,同时不记错误。用于有合理默认值的字段。 */
  fallback?: string;
}

export function readString(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
  options: ReadOptions = {},
): string | undefined {
  const value = source[key];

  if (value === undefined || value === null) {
    if (options.fallback !== undefined) return options.fallback;
    if (options.required !== false) errors.push(`缺字段 \`${key}\``);
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`\`${key}\` 必须是非空字符串,收到 ${describe(value)}`);
    return undefined;
  }

  return value.trim();
}

export function readStringArray(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
  options: { required?: boolean } = {},
): string[] {
  const value = source[key];

  if (value === undefined || value === null) {
    if (options.required) errors.push(`缺字段 \`${key}\``);
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(`\`${key}\` 必须是列表,收到 ${describe(value)}`);
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`\`${key}[${index}]\` 必须是非空字符串,收到 ${describe(item)}`);
      return [];
    }
    return [item.trim()];
  });
}

export function readRecord(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
): Record<string, unknown> | undefined {
  const value = source[key];

  if (value === undefined || value === null) {
    errors.push(`缺字段 \`${key}\``);
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`\`${key}\` 必须是 key: value 块,收到 ${describe(value)}`);
    return undefined;
  }

  return value;
}

export function readArray(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
  options: { required?: boolean } = {},
): unknown[] {
  const value = source[key];

  if (value === undefined || value === null) {
    if (options.required) errors.push(`缺字段 \`${key}\``);
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(`\`${key}\` 必须是列表,收到 ${describe(value)}`);
    return [];
  }

  return value;
}

export function readInt(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
  fallback: number,
): number {
  const value = source[key];

  if (value === undefined || value === null) return fallback;

  // YAML 里 `0` 会被解析成数字,但 `"0"` 也是模型常写的,一并接受
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    errors.push(`\`${key}\` 必须是数字,收到 ${describe(value)}`);
    return fallback;
  }

  return Math.floor(parsed);
}

export function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  errors: Problems,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const value = readString(source, key, errors, fallback === undefined ? {} : { fallback });
  if (value === undefined) return undefined;

  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    errors.push(`\`${key}\` 只能是 ${allowed.map((a) => `\`${a}\``).join(" / ")},收到 \`${value}\``);
    return fallback;
  }

  return match;
}
