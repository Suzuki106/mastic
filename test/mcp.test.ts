import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createLedger } from "../src/ledger.ts";
import { connectMcp, loadMcpConfig, mcpToolName, renderMcpResult } from "../src/mcp/index.ts";
import type { Tool, ToolContext } from "../src/tools/index.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const run of cleanup) await run();
});

function context(workspace: string): ToolContext {
  return {
    workspace,
    runRoot: workspace,
    ledger: createLedger(),
    timeoutMs: 10_000,
    maxOutputChars: 10_000,
  };
}

function toolNamed(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.schema.function.name === name);
  assert.ok(tool !== undefined, `没找到工具 ${name},实际有:${tools.map((t) => t.schema.function.name).join(",")}`);
  return tool;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastic-mcp-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("MCP 客户端", () => {
  it("连上服务、列出工具、调用工具", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: { echo: { command: process.execPath, args: [fixture] } },
      requestTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    cleanup.push(() => mcp.close());

    assert.deepEqual(mcp.problems, []);
    assert.deepEqual(mcp.servers, ["echo"]);

    const names = mcp.tools.map((tool) => tool.schema.function.name);
    assert.ok(names.includes("mcp__echo__echo"));
    assert.ok(names.includes("mcp__echo__add"));

    const echo = toolNamed(mcp.tools, "mcp__echo__echo");
    assert.equal(await echo.run({ text: "你好" }, context(workspace)), "echo:你好");

    const add = toolNamed(mcp.tools, "mcp__echo__add");
    assert.equal(await add.run({ a: 2, b: 40 }, context(workspace)), "42");
  });

  it("工具报错时把 isError 转成错误文本", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: { echo: { command: process.execPath, args: [fixture] } },
      requestTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    cleanup.push(() => mcp.close());

    const boom = toolNamed(mcp.tools, "mcp__echo__boom");
    assert.equal(await boom.run({}, context(workspace)), "错误:炸了");
  });

  it("图片返回变成内容块,模型能真的看到", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: { echo: { command: process.execPath, args: [fixture] } },
      requestTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    cleanup.push(() => mcp.close());

    const pixels = toolNamed(mcp.tools, "mcp__echo__pixels");
    const output = await pixels.run({}, context(workspace));

    assert.ok(Array.isArray(output));
    assert.equal(output[0]?.type, "text");
    const image = output.find((part) => part.type === "image_url");
    assert.ok(image !== undefined);
    if (image.type === "image_url") {
      assert.ok(image.image_url.url.startsWith("data:image/png;base64,"));
    }
  });

  it("服务端发起的请求不会把连接挂住", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: { echo: { command: process.execPath, args: [fixture] } },
      requestTimeoutMs: 5_000,
      callTimeoutMs: 5_000,
    });
    cleanup.push(() => mcp.close());

    const tool = toolNamed(mcp.tools, "mcp__echo__server_request");
    assert.equal(await tool.run({}, context(workspace)), "sent");
  });

  it("一个服务连不上,不影响别的服务", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: {
        broken: { command: join(workspace, "这个命令不存在") },
        echo: { command: process.execPath, args: [fixture] },
      },
      requestTimeoutMs: 3_000,
      callTimeoutMs: 3_000,
    });
    cleanup.push(() => mcp.close());

    assert.deepEqual(mcp.servers, ["echo"]);
    assert.ok(mcp.tools.some((tool) => tool.schema.function.name === "mcp__echo__echo"));
    assert.ok(mcp.problems.some((problem) => problem.includes("broken")));
  });

  it("跳过的服务不会被连", async () => {
    const workspace = await tempDir();
    const mcp = await connectMcp({
      workspace,
      servers: {
        echo: { command: process.execPath, args: [fixture], disabled: true },
      },
    });

    assert.deepEqual(mcp.tools, []);
    assert.deepEqual(mcp.servers, []);
  });
});

describe("MCP 细节", () => {
  it("工具名带服务前缀,并被压成合法字符", () => {
    assert.equal(mcpToolName("my server", "do/thing"), "mcp__my_server__do_thing");
    assert.ok(mcpToolName("s", "x".repeat(100)).length <= 64);
  });

  it("没有 content 时给一句人话", () => {
    assert.equal(renderMcpResult({ content: [], isError: false }, 100), "(没有返回内容)");
  });

  it("文本会被截断", () => {
    const out = renderMcpResult({ content: [{ type: "text", text: "x".repeat(50) }], isError: false }, 10);
    assert.ok(typeof out === "string" && out.includes("已截断"));
  });

  it("用户级和项目级配置合并,项目级覆盖同名", async () => {
    const workspace = await tempDir();
    const userDir = join(workspace, "user-config");
    await mkdir(userDir, { recursive: true });
    await mkdir(join(workspace, ".mastic"), { recursive: true });

    await writeFile(
      join(userDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "user-cmd" },
          onlyUser: { command: "user-only" },
        },
      }),
    );
    await writeFile(
      join(workspace, ".mastic", "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "project-cmd" } } }),
    );

    const loaded = await loadMcpConfig(workspace, { userConfigDir: userDir });
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.servers.shared?.command, "project-cmd");
    assert.equal(loaded.servers.onlyUser?.command, "user-only");
  });

  it("坏掉的配置文件只是记一条问题,不抛异常", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, ".mastic"), { recursive: true });
    await writeFile(join(workspace, ".mastic", "mcp.json"), "{ 这不是 json");

    const loaded = await loadMcpConfig(workspace, { userConfigDir: join(workspace, "nope") });
    assert.deepEqual(loaded.servers, {});
    assert.equal(loaded.problems.length, 1);
  });
});
