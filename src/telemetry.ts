import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";

/**
 * OpenTelemetry GenAI 语义约定的最小实现。
 *
 * 不加 @opentelemetry/* 依赖:它们会把一个零构建、单依赖的项目变成一棵
 * 依赖树,而这里需要的只是「把结构化 span POST 到 /v1/traces」这一件事。
 * 用的是 OTLP/HTTP 的 JSON 编码 —— 协议本身是标准,Jaeger / Tempo /
 * Collector / Opik 都直接收。
 *
 * 两条纪律:
 *
 * 1. **没配 endpoint 时什么都不做。** 不建 span、不排队、不占内存。
 * 2. **导出失败不影响运行。** 可观测性挂了是少一份数据,不是运行该失败的理由。
 */

export type AttributeValue = string | number | boolean;

export interface SpanAttributes {
  [key: string]: AttributeValue | undefined;
}

export interface SpanHandle {
  setAttribute(key: string, value: AttributeValue | undefined): void;
  /** 设置错误状态。异常本身由 span() 自动捕获,这个给"返回值表示失败"的场合用。 */
  setError(message: string): void;
}

interface RecordedAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
}

interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1 | 3;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: RecordedAttribute[];
  status?: { code: 0 | 1 | 2; message?: string };
}

export interface TracerOptions {
  /** 例如 `http://localhost:4318`。不填 = 关闭。 */
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  /** 测试用:替换 fetch。 */
  fetchImpl?: typeof fetch;
  /** 一次最多缓存多少 span,防止 collector 长期不可达时内存无限涨。 */
  maxSpans?: number;
}

const SCOPE_NAME = "mastic";
const SCOPE_VERSION = "0.1.0";
const DEFAULT_MAX_SPANS = 5_000;
const EXPORT_TIMEOUT_MS = 3_000;

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nano(date: number): string {
  return (BigInt(date) * 1_000_000n).toString();
}

function encodeValue(value: AttributeValue): RecordedAttribute["value"] {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return { intValue: Number.isInteger(value) ? String(value) : String(Math.round(value)) };
  }
  return { stringValue: value };
}

function appendAttributes(target: RecordedAttribute[], attrs: SpanAttributes): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    target.push({ key, value: encodeValue(value) });
  }
}

export class Tracer {
  readonly enabled: boolean;
  private readonly endpoint: string | undefined;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxSpans: number;

  private spans: RecordedSpan[] = [];
  private dropped = 0;
  private lastError: string | undefined;

  constructor(options: TracerOptions = {}) {
    this.endpoint = options.endpoint?.replace(/\/+$/, "");
    this.enabled = this.endpoint !== undefined && this.endpoint !== "";
    this.serviceName = options.serviceName ?? "mastic";
    this.serviceVersion = options.serviceVersion ?? SCOPE_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
  }

  /** 由 span() 调用。parent 由 AsyncLocalStorage 里的活动 span 决定。 */
  _start(name: string, kind: 1 | 3, parent: { traceId: string; spanId: string } | undefined): {
    span: RecordedSpan;
    handle: SpanHandle;
    end(): void;
  } {
    const start = Date.now();
    const span: RecordedSpan = {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
      name,
      kind,
      startTimeUnixNano: nano(start),
      endTimeUnixNano: nano(start),
      attributes: [],
    };

    let ended = false;
    const handle: SpanHandle = {
      setAttribute(key, value) {
        if (ended || value === undefined) return;
        appendAttributes(span.attributes, { [key]: value });
      },
      setError(message) {
        if (ended) return;
        span.status = { code: 2, message };
      },
    };

    return {
      span,
      handle,
      end: () => {
        if (ended) return;
        ended = true;
        span.endTimeUnixNano = nano(Date.now());
        if (this.spans.length >= this.maxSpans) {
          this.dropped += 1;
          return;
        }
        this.spans.push(span);
      },
    };
  }

  /** 缓冲里有多少 span —— 测试和诊断用。 */
  get pending(): number {
    return this.spans.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get lastExportError(): string | undefined {
    return this.lastError;
  }

  /** 把缓存的 span 一次性发出去。失败只记在 lastError 里,不抛。 */
  async flush(): Promise<void> {
    if (!this.enabled || this.spans.length === 0) return;

    const spans = this.spans;
    this.spans = [];

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
              { key: "service.version", value: { stringValue: this.serviceVersion } },
              { key: "telemetry.sdk.name", value: { stringValue: SCOPE_NAME } },
              { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
              spans,
            },
          ],
        },
      ],
    };

    try {
      const response = await this.fetchImpl(`${this.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.lastError = `HTTP ${response.status}`;
      } else {
        this.lastError = undefined;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

interface Context {
  tracer: Tracer;
  parent: { traceId: string; spanId: string } | undefined;
}

const storage = new AsyncLocalStorage<Context>();

/** 在一个 tracer 的上下文里跑一段。没装上下文时 span() 是空操作。 */
export async function withTelemetry<T>(tracer: Tracer, fn: () => Promise<T> | T): Promise<T> {
  if (!tracer.enabled) return await fn();
  return await storage.run({ tracer, parent: undefined }, fn);
}

/** 当前是不是已经在某个 run 的追踪上下文里 —— 防止 resume 那条链路重复建根。 */
export function activeTracer(): Tracer | undefined {
  return storage.getStore()?.tracer;
}

/**
 * 给一个入口(续跑、重验)装上追踪。
 *
 * 已经在别的 run 上下文里就直接跑 —— 否则 `continueRun → resumeRun`
 * 会各建一个根 span,同一次运行被拆成两棵树。
 */
export async function withRunTelemetry<T>(
  config: Config,
  runId: string,
  goal: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (activeTracer() !== undefined) return await workflowSpan(runId, goal, fn);

  const tracer = tracerFromConfig(config);
  return await withTelemetry(tracer, async () => {
    try {
      return await workflowSpan(runId, goal, fn);
    } finally {
      await tracer.flush();
    }
  });
}

/**
 * 开一个 span 跑 fn。自动收尾、自动把异常记成 ERROR 状态并继续抛。
 *
 * 父 span 从 AsyncLocalStorage 里拿 —— 这样 planner/worker/tool loop 不必
 * 层层传一个 tracer 参数,也就不会有人漏传。
 */
export async function span<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (handle: SpanHandle) => Promise<T> | T,
  kind: 1 | 3 = 1,
): Promise<T> {
  const context = storage.getStore();
  if (context === undefined || !context.tracer.enabled) {
    return await fn(NOOP_HANDLE);
  }

  const started = context.tracer._start(name, kind, context.parent);
  appendAttributes(started.span.attributes, attrs);

  try {
    const result = await storage.run(
      { tracer: context.tracer, parent: { traceId: started.span.traceId, spanId: started.span.spanId } },
      () => fn(started.handle),
    );
    if (started.span.status === undefined) started.span.status = { code: 1 };
    return result;
  } catch (error) {
    started.span.status = {
      code: 2,
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    started.end();
  }
}

const NOOP_HANDLE: SpanHandle = {
  setAttribute() {},
  setError() {},
};

const PROVIDERS: [RegExp, string][] = [
  [/deepseek/i, "deepseek"],
  [/openai\.com/i, "openai"],
  [/moonshot/i, "moonshot"],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/i, "ollama"],
];

/** 从 baseUrl 猜 provider。猜不出来就报 hostname —— 比编一个准。 */
export function providerName(baseUrl: string): string {
  for (const [pattern, name] of PROVIDERS) {
    if (pattern.test(baseUrl)) return name;
  }

  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "unknown";
  }
}

export function tracerFromConfig(config: Config): Tracer {
  return new Tracer({
    ...(config.otelEndpoint === undefined ? {} : { endpoint: config.otelEndpoint }),
  });
}

/** 一次运行的根 span。traceId 由它创建,下游都是它的子孙。 */
export function workflowSpan<T>(runId: string, goal: string, fn: () => Promise<T> | T): Promise<T> {
  return span(
    "invoke_workflow mastic",
    {
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.workflow.name": "mastic",
      "gen_ai.conversation.id": runId,
      // 目标本身可能很长,截一下;它是给人定位用的,不是证据
      "mastic.goal": goal.slice(0, 200),
    },
    fn,
  );
}

export function agentSpan<T>(
  agent: "planner" | "worker" | "verifier",
  attrs: SpanAttributes,
  fn: (handle: SpanHandle) => Promise<T> | T,
): Promise<T> {
  return span(
    `invoke_agent ${agent}`,
    {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": agent,
      ...attrs,
    },
    fn,
  );
}
