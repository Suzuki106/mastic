import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLedger } from "../src/ledger.ts";
import { findTool, workerTools, type ToolContext } from "../src/tools/index.ts";

const root = await mkdtemp(join(tmpdir(), "mastic-tools-"));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx: ToolContext = {
  workspace: root,
  runRoot: root,
  ledger: createLedger(),
  timeoutMs: 10_000,
  maxOutputChars: 4000,
};

function tool(name: string) {
  const found = findTool(workerTools, name);
  assert.ok(found, `没有 ${name} 工具`);
  return found;
}

async function failsWith(name: string, args: Record<string, unknown>, fragment: string): Promise<void> {
  await assert.rejects(
    () => tool(name).run(args, ctx),
    (error: Error) => error.message.includes(fragment),
    `报错里应当提到「${fragment}」`,
  );
}

describe("write_file", () => {
  it("普通代码文件照写", async () => {
    const out = await tool("write_file").run({ path: "src/a.py", content: "print(1)\n" }, ctx);
    assert.ok(out.includes("已写入"));
    assert.equal(await readFile(join(root, "src/a.py"), "utf8"), "print(1)\n");
  });

  /**
   * 这条是整个数据自证方向最省事的那条造假路径:模型直接 write_file 写一份
   * "实验数据"。内容来自模型,不经过任何外部地址 —— 拿它跑实验等于什么都没测。
   */
  it("数据文件写不了,而且说清该走哪条路", async () => {
    await failsWith("write_file", { path: "data/ridership.csv", content: "a,b\n1,2\n" }, "不能用 write_file 直接写");
    await failsWith("write_file", { path: "x.jsonl", content: "{}\n" }, "fetch_url");
    await failsWith("write_file", { path: "y.parquet", content: "x" }, "run_bash");
  });

  it("配置和笔记不受影响 —— .json 常常是配置,不拦", async () => {
    const out = await tool("write_file").run({ path: "spec/params.json", content: "{}\n" }, ctx);
    assert.ok(out.includes("已写入"));
  });
});

describe("fetch_url", () => {
  it("不是 http(s) 的直接拒掉", async () => {
    await failsWith("fetch_url", { url: "file:///etc/passwd" }, "http(s)");
    await failsWith("fetch_url", { url: "随便写的" }, "http(s)");
  });
});

describe("联网工具接了进来", () => {
  it("worker 拿得到搜索和抓取", () => {
    assert.ok(findTool(workerTools, "web_search"));
    assert.ok(findTool(workerTools, "fetch_url"));
  });
});
