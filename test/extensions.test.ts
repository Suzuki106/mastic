import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { work } from "../src/agent/worker.ts";
import { plan } from "../src/agent/planner.ts";
import type { ChatFn } from "../src/agent/loop.ts";
import type { Config } from "../src/config.ts";
import { parseTaskDoc } from "../src/doc/task.ts";
import type { ChatResult, Message, StreamOptions, ToolSchema } from "../src/llm.ts";
import { loadExtensions } from "../src/extensions.ts";
import { connectMcp } from "../src/mcp/index.ts";
import { discoverSkills, loadSkill } from "../src/skills.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");

const config: Config = {
  apiKey: "test",
  baseUrl: "http://unused",
  model: "test",
  workspace: "/tmp",
  concurrency: 1,
  maxRetries: 0,
  plannerSteps: 40,
  runBudgetSteps: 400,
  taskStepCeiling: 80,
  commandTimeoutMs: 10_000,
  requestIdleTimeoutMs: 1_000,
  vision: true,
  mcp: true,
  skills: true,
};

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const run of cleanup) await run();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastic-ext-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function textOf(message: Message): string {
  const { content } = message;
  if (content === null || typeof content === "string") return content ?? "";
  return content.map((part) => (part.type === "text" ? part.text : "[图]")).join("");
}

function reply(text: string, calls: { name: string; args?: unknown }[] = []): ChatResult {
  return {
    reply: text,
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    toolCalls: calls.map((call, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  };
}

const REPORT = `---
task: T-001
claims:
  - statement: 命令跑过了
    evidence:
      - ref: C1
unresolved: []
---

## 做了什么

跑了一条命令。
`;

const TASK = `---
id: T-001
title: 走一遍外挂
goal: 用上技能和 MCP
skills: [crawler]
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
---
`;

describe("loadExtensions", () => {
  it("从工作区的 .mastic 里读配置和技能", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, ".mastic", "skills", "crawler"), { recursive: true });
    await writeFile(
      join(workspace, ".mastic", "skills", "crawler", "SKILL.md"),
      "---\nname: crawler\ndescription: 怎么抓\n---\n\n先登录。\n",
    );
    await writeFile(
      join(workspace, ".mastic", "mcp.json"),
      JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [fixture] } },
      }),
    );

    const messages: string[] = [];
    const ext = await loadExtensions({
      config,
      workspace,
      userConfigDir: join(workspace, "no-user"),
      onEvent: (detail) => messages.push(detail),
    });
    cleanup.push(() => ext.close());

    assert.deepEqual(ext.skills.map((skill) => skill.name), ["crawler"]);
    assert.ok(ext.mcpTools.some((tool) => tool.schema.function.name === "mcp__echo__echo"));
    assert.ok(messages.some((detail) => detail.includes("MCP")));
    assert.ok(messages.some((detail) => detail.includes("技能 1 个")));
  });

  it("关掉开关就什么都不加载", async () => {
    const workspace = await tempDir();
    const ext = await loadExtensions({
      config: { ...config, mcp: false, skills: false },
      workspace,
      userConfigDir: join(workspace, "no-user"),
    });
    assert.deepEqual(ext.mcpTools, []);
    assert.deepEqual(ext.skills, []);
  });
});

describe("planner 看技能", () => {
  it("索引写进提示词,任务书写错名字会被打回", async () => {
    const workspace = await tempDir();
    const skills = [
      { name: "crawler", description: "怎么抓", dir: workspace, source: "workspace" as const },
    ];

    const systems: string[] = [];
    const secondRound: string[] = [];
    let round = 0;

    const task = (skill: string): string =>
      `---
id: T-001
title: 抓
goal: 把东西抓下来
skills: [${skill}]
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
---
`;

    const chat: ChatFn = async (_config, messages: Message[], _options?: StreamOptions) => {
      systems.push(textOf(messages[0] ?? { role: "system", content: "" }));
      if (round === 1) secondRound.push(...messages.map(textOf));

      round += 1;
      return reply("", [
        { name: "submit_plan", args: { tasks: [task(round === 1 ? "nope" : "crawler")] } },
      ]);
    };

    const result = await plan({
      config,
      goal: "抓点东西",
      workspace,
      runRoot: workspace,
      skills,
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      discoveryTools: [],
      maxSteps: 5,
      chat,
    });

    assert.ok(systems[0]?.includes("可用技能"));
    assert.ok(systems[0]?.includes("`crawler`"));
    // 写错的名字被退回,而不是悄悄写进任务书
    assert.ok(secondRound.some((text) => text.includes("不存在的技能")));
    assert.equal(result.tasks.length, 1);
    assert.deepEqual(result.tasks[0]?.skills, ["crawler"]);
  });
});

describe("worker 拿到技能与 MCP 工具", () => {
  it("手册正文进提示词,技能工具和 MCP 工具进工具表", async () => {
    const workspace = await tempDir();
    const runRoot = join(workspace, ".mastic", "runs", "r1");
    await mkdir(runRoot, { recursive: true });

    const skillDir = join(workspace, ".mastic", "skills", "crawler");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: crawler\ndescription: 怎么抓\n---\n\n先登录,再抓。\n",
    );

    const skills = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    const skill = await loadSkill(skills[0]!);
    assert.ok(skill !== null);

    const mcp = await connectMcp({
      workspace,
      servers: { echo: { command: process.execPath, args: [fixture] } },
      requestTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    cleanup.push(() => mcp.close());

    const { task, errors } = parseTaskDoc(TASK);
    assert.deepEqual(errors, []);
    assert.ok(task !== undefined);

    const seen: { tools: ToolSchema[]; user: string; toolResults: string[] }[] = [];
    let round = 0;

    const chat: ChatFn = async (_config, messages: Message[], options?: StreamOptions) => {
      seen.push({
        tools: options?.tools ?? [],
        user: textOf(messages[1] ?? { role: "user", content: "" }),
        toolResults: messages
          .filter((message) => message.role === "tool")
          .map((message) => textOf(message)),
      });

      round += 1;
      if (round === 1) {
        return reply("", [
          { name: "mcp__echo__echo", args: { text: "hi" } },
          { name: "run_bash", args: { command: "echo ok" } },
        ]);
      }
      return reply("", [{ name: "submit_report", args: { report: REPORT } }]);
    };

    const result = await work({
      config,
      task,
      workspace,
      runRoot,
      timeoutMs: 10_000,
      maxOutputChars: 10_000,
      maxSteps: 10,
      skills,
      mcpTools: mcp.tools,
      chat,
    });

    // 提示词里真的有手册正文,也真的说了 MCP 结果不能当证据
    assert.ok(seen[0]?.user.includes("先登录,再抓。"));
    assert.ok(seen[0]?.user.includes("不能当证据"));

    // 工具表里有技能附件读取和 MCP 工具
    const names = (seen[0]?.tools ?? []).map((tool) => tool.function.name);
    assert.ok(names.includes("read_skill_file"));
    assert.ok(names.includes("mcp__echo__echo"));
    assert.ok(names.includes("submit_report"));

    // MCP 调用真的执行了:结果作为 tool 消息回灌给了模型
    assert.ok(seen[1]?.toolResults.some((text) => text.includes("echo:hi")));

    assert.ok(result.report !== undefined, result.failure);
    assert.equal(result.report?.task, "T-001");
    assert.equal(result.report?.claims.length, 1);
  });
});
