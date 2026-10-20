import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLedger } from "../src/ledger.ts";
import type { ContentPart } from "../src/llm.ts";
import { findTool, workerTools, type ToolContext } from "../src/tools/index.ts";

/** 工具返回可能是内容块,断言前拍平成文字。 */
function textOf(output: string | ContentPart[]): string {
  if (typeof output === "string") return output;
  return output.map((p) => (p.type === "text" ? p.text : "[图]")).join(" ");
}

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
    assert.ok(textOf(out).includes("已写入"));
    assert.equal(await readFile(join(root, "src/a.py"), "utf8"), "print(1)\n");
  });

  /**
   * 这条是整个数据自证方向最省事的那条造假路径:模型直接 write_file 写一份
   * "实验数据"。内容来自模型,不经过任何外部地址 —— 拿它跑实验等于什么都没测。
   */
  // 两条不同的规则,报的错也不一样:
  //   data/ 下的任何文件 —— 那是原始数据区,按位置拦
  //   别处的数据扩展名   —— 那是数据文件,按内容来源拦
  it("原始数据区里什么都不能写", async () => {
    await failsWith("write_file", { path: "data/ridership.csv", content: "a,b\n1,2\n" }, "原始数据区");
    await failsWith("write_file", { path: "data/notes.md", content: "记一笔" }, "原始数据区");
  });

  it("别处的数据文件也写不了,而且说清该走哪条路", async () => {
    await failsWith("write_file", { path: "x.jsonl", content: "{}\n" }, "不能用 write_file 直接写");
    await failsWith("write_file", { path: "y.parquet", content: "x" }, "run_bash");
    await failsWith("write_file", { path: "sub/z.csv", content: "a\n1\n" }, "fetch_url");
  });

  it("配置和笔记不受影响 —— .json 常常是配置,不拦", async () => {
    const out = await tool("write_file").run({ path: "spec/params.json", content: "{}\n" }, ctx);
    assert.ok(textOf(out).includes("已写入"));
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

describe("read_image", () => {
  it("返回内容块:文字 + 真正的图片", async () => {
    const { copyFile } = await import("node:fs/promises");
    await copyFile("/home/vessel/mastic/assets/logo.png", join(root, "logo.png"));

    const out = await tool("read_image").run({ path: "logo.png" }, ctx);
    assert.ok(Array.isArray(out), "应当是内容块而不是纯文本");

    const parts = out as ContentPart[];
    assert.equal(parts.length, 2);
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[1]?.type, "image_url");
    assert.ok((parts[1] as { image_url: { url: string } }).image_url.url.startsWith("data:image/png;base64,"));
  });

  it("看过的图会记进台账 —— 溯源检查靠它认出来", async () => {
    const before = ctx.ledger.files.length;
    await tool("read_image").run({ path: "logo.png" }, ctx);
    assert.equal(ctx.ledger.files.length, before + 1);
    assert.equal(ctx.ledger.files.at(-1)?.path, "logo.png");
  });

  it("不是图片的拒掉", async () => {
    await failsWith("read_image", { path: "src/a.py" }, "不是支持的图片格式");
  });

  it("读不到的给清楚的错", async () => {
    await failsWith("read_image", { path: "没有这张.png" }, "读不到");
  });

  it("越界路径挡得住", async () => {
    await failsWith("read_image", { path: "../../etc/passwd.png" }, "工作目录外");
  });
});
