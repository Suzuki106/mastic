import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import { runToolLoop, type ChatFn } from "../src/agent/loop.ts";
import type { Config } from "../src/config.ts";
import { createLedger } from "../src/ledger.ts";
import type { ChatResult } from "../src/llm.ts";
import { agentSpan, span, Tracer, withTelemetry, workflowSpan } from "../src/telemetry.ts";
import type { Tool } from "../src/tools/index.ts";

interface Captured {
  requests: string[];
  bodies: unknown[];
}

const servers: Server[] = [];

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function collector(): Promise<{ endpoint: string; captured: Captured }> {
  const captured: Captured = { requests: [], bodies: [] };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.requests.push(`${request.method} ${request.url}`);
      captured.bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("没拿到端口");

  return { endpoint: `http://127.0.0.1:${address.port}`, captured };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: { key: string; value: Record<string, unknown> }[];
  status?: { code: number; message?: string };
}

function spansOf(body: unknown): OtlpSpan[] {
  const payload = body as {
    resourceSpans: {
      resource: { attributes: { key: string; value: Record<string, unknown> }[] };
      scopeSpans: { spans: OtlpSpan[] }[];
    }[];
  };

  return payload.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
}

function attr(span: OtlpSpan, key: string): unknown {
  return span.attributes.find((item) => item.key === key)?.value;
}

describe("OTLP 导出", () => {
  it("父 span 关系、GenAI 属性与资源标识都写进了 payload", async () => {
    const { endpoint, captured } = await collector();
    const tracer = new Tracer({ endpoint, serviceName: "mastic-test" });

    await withTelemetry(tracer, async () => {
      await workflowSpan("run-1", "把东西做出来", async () => {
        await agentSpan("planner", {}, async () => {
          await span(
            "chat test-model",
            { "gen_ai.operation.name": "chat", "gen_ai.request.model": "test-model" },
            (handle) => {
              handle.setAttribute("gen_ai.usage.input_tokens", 12);
              handle.setAttribute("gen_ai.usage.output_tokens", 7);
            },
            3,
          );
        });
      });
    });

    await tracer.flush();

    assert.equal(captured.requests.length, 1);
    assert.equal(captured.requests[0], "POST /v1/traces");

    const body = captured.bodies[0] as {
      resourceSpans: { resource: { attributes: { key: string }[] } }[];
    };
    const resourceKeys = body.resourceSpans[0]?.resource.attributes.map((item) => item.key) ?? [];
    assert.ok(resourceKeys.includes("service.name"));
    assert.ok(resourceKeys.includes("service.version"));

    const spans = spansOf(captured.bodies[0]);
    // span 在结束时入队,所以内层先到 —— 顺序不代表层级
    assert.deepEqual(
      spans.map((item) => item.name).sort(),
      ["chat test-model", "invoke_agent planner", "invoke_workflow mastic"],
    );

    const workflow = spans.find((item) => item.name === "invoke_workflow mastic");
    const agent = spans.find((item) => item.name === "invoke_agent planner");
    const chat = spans.find((item) => item.name === "chat test-model");
    assert.ok(workflow !== undefined && agent !== undefined && chat !== undefined);

    // 同一个 trace,父子接得上
    assert.equal(agent.traceId, workflow.traceId);
    assert.equal(chat.traceId, workflow.traceId);
    assert.equal(agent.parentSpanId, workflow.spanId);
    assert.equal(chat.parentSpanId, agent.spanId);

    assert.deepEqual(attr(workflow, "gen_ai.operation.name"), { stringValue: "invoke_workflow" });
    assert.deepEqual(attr(workflow, "gen_ai.conversation.id"), { stringValue: "run-1" });
    assert.deepEqual(attr(chat, "gen_ai.usage.input_tokens"), { intValue: "12" });
    assert.deepEqual(attr(chat, "gen_ai.usage.output_tokens"), { intValue: "7" });
    assert.equal(chat.kind, 3);
    assert.equal(chat.status?.code, 1);
  });

  it("异常会被记成 ERROR 并继续抛", async () => {
    const { endpoint, captured } = await collector();
    const tracer = new Tracer({ endpoint });

    await withTelemetry(tracer, async () => {
      await assert.rejects(
        span("execute_tool boom", { "gen_ai.tool.name": "boom" }, () => {
          throw new Error("工具炸了");
        }),
        /工具炸了/,
      );
    });

    await tracer.flush();

    const [span0] = spansOf(captured.bodies[0]);
    assert.equal(span0?.status?.code, 2);
    assert.equal(span0?.status?.message, "工具炸了");
  });

  it("没配 endpoint 时一个请求都不发", async () => {
    let called = 0;
    const tracer = new Tracer({
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}");
      }) as typeof fetch,
    });

    await withTelemetry(tracer, async () => {
      await span("chat x", {}, () => undefined);
    });
    await tracer.flush();

    assert.equal(called, 0);
    assert.equal(tracer.pending, 0);
  });

  it("导出失败只记在 lastExportError,不抛", async () => {
    const tracer = new Tracer({
      endpoint: "http://127.0.0.1:1",
      fetchImpl: (async () => {
        throw new Error("collector 没开");
      }) as typeof fetch,
    });

    await withTelemetry(tracer, () => span("chat x", {}, () => undefined));
    await tracer.flush();

    assert.equal(tracer.lastExportError, "collector 没开");
  });
});

describe("工具循环的追踪", () => {
  it("每次模型调用和每次工具执行都留下 span", async () => {
    const { endpoint, captured } = await collector();
    const tracer = new Tracer({ endpoint });

    const config: Config = {
      apiKey: "test",
      baseUrl: "https://api.deepseek.com/v1",
      model: "test-model",
      workspace: "/tmp",
      concurrency: 1,
      maxRetries: 0,
      plannerSteps: 5,
      runBudgetSteps: 10,
      taskStepCeiling: 5,
      commandTimeoutMs: 5_000,
      requestIdleTimeoutMs: 1_000,
      vision: false,
      mcp: false,
      skills: false,
    };

    const echo: Tool = {
      schema: {
        type: "function",
        function: { name: "echo", description: "回声", parameters: { type: "object", properties: {} } },
      },
      async run() {
        return "ok";
      },
    };

    let round = 0;
    const chat: ChatFn = async (): Promise<ChatResult> => {
      round += 1;
      if (round === 1) {
        return {
          reply: "",
          finishReason: "tool_calls",
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          toolCalls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }],
        };
      }
      return {
        reply: "",
        finishReason: "tool_calls",
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        toolCalls: [{ id: "call_2", type: "function", function: { name: "submit_report", arguments: "{}" } }],
      };
    };

    await withTelemetry(tracer, async () => {
      const result = await runToolLoop({
        config,
        system: "系统提示",
        user: "用户消息",
        tools: [echo],
        toolContext: {
          workspace: "/tmp",
          runRoot: "/tmp",
          ledger: createLedger(),
          timeoutMs: 5_000,
          maxOutputChars: 1_000,
        },
        terminalTool: "submit_report",
        onTerminal: () => undefined,
        maxSteps: 3,
        agentName: "worker",
        chat,
      });

      assert.equal(result.status, "submitted");
    });

    await tracer.flush();

    const spans = spansOf(captured.bodies[0]);
    const names = spans.map((item) => item.name);

    assert.equal(names.filter((name) => name === "chat test-model").length, 2);
    assert.equal(names.filter((name) => name === "execute_tool echo").length, 1);
    assert.deepEqual(attr(spans.find((item) => item.name === "chat test-model")!, "gen_ai.agent.name"), {
      stringValue: "worker",
    });
    assert.deepEqual(attr(spans.find((item) => item.name === "execute_tool echo")!, "gen_ai.tool.name"), {
      stringValue: "echo",
    });
  });
});
