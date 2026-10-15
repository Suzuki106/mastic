import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolLoop, type ChatFn, type LoopEvent } from "../src/agent/loop.ts";
import type { Config } from "../src/config.ts";
import type { ChatResult, Message } from "../src/llm.ts";
import { createLedger } from "../src/ledger.ts";
import type { Tool, ToolContext } from "../src/tools/index.ts";

const config: Config = {
  apiKey: "test",
  baseUrl: "http://unused",
  model: "test",
  workspace: "/tmp",
  concurrency: 1,
  maxRetries: 0,
  maxSteps: 30,
  commandTimeoutMs: 1000,
  requestIdleTimeoutMs: 1000,
  vision: true,
};

const toolContext: ToolContext = {
  workspace: "/tmp",
  ledger: createLedger(),
  timeoutMs: 1000,
  maxOutputChars: 1000,
};

/** 一个不干活的工具,用来验证"非终止工具会被真的执行"。 */
const echoTool: Tool = {
  schema: {
    type: "function",
    function: { name: "echo", description: "回声", parameters: { type: "object", properties: {} } },
  },
  async run(args) {
    return `echo:${String(args.value ?? "")}`;
  },
};

const endTool: Tool = {
  schema: {
    type: "function",
    function: { name: "finish", description: "交卷", parameters: { type: "object", properties: {} } },
  },
  async run() {
    throw new Error("终止工具不该被真的执行");
  },
};

/** 消息内容现在是 string、内容块数组、或 assistant 那边的 null,断言前先拍平成文字。 */
function textOf(message: Message): string {
  const { content } = message;
  if (content === null || typeof content === "string") return content ?? "";
  return content.map((part) => (part.type === "text" ? part.text : "[图]")).join("");
}

function reply(text: string, calls: { name: string; args?: unknown }[] = []): ChatResult {
  return {
    reply: text,
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    toolCalls: calls.map((call, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  };
}

/** 按剧本依次返回;剧本用完就重复最后一条。 */
function scripted(responses: ChatResult[]): { chat: ChatFn; calls: Message[][] } {
  const calls: Message[][] = [];
  let index = 0;

  const chat: ChatFn = async (_config, messages) => {
    calls.push([...messages]);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    assert.ok(response, "剧本不能为空");
    return response;
  };

  return { chat, calls };
}

async function run(
  responses: ChatResult[],
  options: { maxSteps?: number; onTerminal?: (args: Record<string, unknown>) => string | undefined } = {},
): Promise<{ result: Awaited<ReturnType<typeof runToolLoop>>; calls: Message[][]; events: LoopEvent[] }> {
  const { chat, calls } = scripted(responses);
  const events: LoopEvent[] = [];

  const result = await runToolLoop({
    config,
    system: "系统",
    user: "用户",
    tools: [echoTool, endTool],
    toolContext,
    terminalTool: "finish",
    maxSteps: options.maxSteps ?? 30,
    chat,
    onEvent: (event) => events.push(event),
    onTerminal: options.onTerminal ?? (() => undefined),
  });

  return { result, calls, events };
}

describe("工具循环", () => {
  it("交卷即结束,并把参数带出来", async () => {
    const { result } = await run([reply("做完了", [{ name: "finish", args: { ok: true } }])]);
    assert.equal(result.status, "submitted");
    assert.deepEqual(result.terminalArgs, { ok: true });
  });

  it("非终止工具会被真的执行,结果回灌给模型", async () => {
    const { result, calls } = await run([
      reply("先探一下", [{ name: "echo", args: { value: "hi" } }]),
      reply("探完了", [{ name: "finish" }]),
    ]);

    assert.equal(result.status, "submitted");
    const fedBack = calls[1]?.find((message) => message.role === "tool");
    assert.equal(fedBack === undefined ? "" : textOf(fedBack), "echo:hi");
  });

  it("交卷被打回时继续下一轮,而不是收下坏文档", async () => {
    let attempts = 0;
    const { result } = await run(
      [
        // 两次调用的参数必须不同 —— 否则会先被"卡住"判定拦下,走不到打回
        reply("", [{ name: "finish", args: { v: 1 } }]),
        reply("", [{ name: "finish", args: { v: 2 } }]),
      ],
      {
        onTerminal: () => {
          attempts += 1;
          return attempts === 1 ? "少了点东西,改完再交" : undefined;
        },
      },
    );

    assert.equal(attempts, 2, "应当被打回一次");
    assert.equal(result.status, "submitted");
    assert.deepEqual(result.terminalArgs, { v: 2 }, "收下的应当是改过的那一份");
  });

  it("模型不调工具就停下时,会把它顶回去而不是当成做完了", async () => {
    const { result, calls } = await run([
      reply("我觉得做完了"),
      reply("", [{ name: "finish" }]),
    ]);

    assert.equal(result.status, "submitted");
    const nudged = calls[1]?.some(
      (message) => message.role === "user" && textOf(message).includes("finish"),
    );
    assert.ok(nudged, "应当有一条提醒它交卷的消息");
  });

  // 这条是实测出来的:自举任务在真实仓库里光读文件就把步数花光了。
  // 老行为是直接判失败、重试从头再来 —— 同一个任务永远卡在同样的步数上。
  it("步数用尽后会强制再给一轮专门交卷", async () => {
    // maxSteps=1:第一轮正常干活把额度用光,第二轮就是被强要的那一轮
    const { result, calls, events } = await run(
      [
        reply("还在忙", [{ name: "echo", args: { value: "1" } }]),
        reply("", [{ name: "finish", args: { partial: true } }]),
      ],
      { maxSteps: 1 },
    );

    assert.equal(result.status, "submitted");
    assert.deepEqual(result.terminalArgs, { partial: true });

    const forced = calls.at(-1)?.some(
      (message) => message.role === "user" && textOf(message).includes("步数已经用尽"),
    );
    assert.ok(forced, "应当有一条要求交卷的消息");
    assert.ok(events.some((event) => event.detail.includes("要它交卷")));
  });

  it("强给的那一轮也不交卷,才真的判失败", async () => {
    const { result } = await run([reply("没完没了", [{ name: "echo", args: { value: "1" } }])], {
      maxSteps: 1,
    });
    assert.equal(result.status, "steps");
    assert.equal(result.terminalArgs, null);
  });

  it("连着两次一模一样的调用会判卡住,而不是空转到步数用尽", async () => {
    const { result, events } = await run([
      reply("", [{ name: "echo", args: { value: "same" } }]),
      reply("", [{ name: "echo", args: { value: "same" } }]),
    ]);

    assert.equal(result.status, "steps");
    assert.ok(events.some((event) => event.detail.includes("卡住")));
  });

  it("参数不是合法 JSON 时报错回灌,不炸掉整个循环", async () => {
    const { chat } = scripted([
      {
        reply: "",
        finishReason: "tool_calls",
        usage: null,
        toolCalls: [
          { id: "x", type: "function", function: { name: "echo", arguments: "{坏 JSON" } },
        ],
      },
      reply("", [{ name: "finish" }]),
    ]);

    const events: LoopEvent[] = [];
    const result = await runToolLoop({
      config,
      system: "s",
      user: "u",
      tools: [echoTool, endTool],
      toolContext,
      terminalTool: "finish",
      maxSteps: 10,
      chat,
      onEvent: (event) => events.push(event),
      onTerminal: () => undefined,
    });

    assert.equal(result.status, "submitted");
  });

  it("不认识的工具会被拒绝,不会中断循环", async () => {
    const { result } = await run([
      reply("", [{ name: "不存在的工具" }]),
      reply("", [{ name: "finish" }]),
    ]);
    assert.equal(result.status, "submitted");
  });

  // 图片是内容块数组形式发给接口的,得确认它原样传到了第一次请求上
  it("带图的 user 消息按内容块发出去", async () => {
    const { chat } = scripted([reply("", [{ name: "finish" }])]);
    const calls: Message[][] = [];

    await runToolLoop({
      config,
      system: "s",
      user: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
      tools: [echoTool, endTool],
      toolContext,
      terminalTool: "finish",
      maxSteps: 5,
      chat: async (_config, messages) => {
        calls.push([...messages]);
        return reply("", [{ name: "finish" }]);
      },
      onTerminal: () => undefined,
    });

    const sent = calls[0]?.find((message) => message.role === "user");
    assert.ok(Array.isArray(sent?.content), "带图时应当是内容块数组");
    assert.deepEqual(sent?.content, [
      { type: "text", text: "看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("用量逐轮累加", async () => {
    const { result } = await run([
      reply("", [{ name: "echo", args: { value: "1" } }]),
      reply("", [{ name: "finish" }]),
    ]);
    assert.equal(result.usage?.total_tokens, 30);
  });
});
