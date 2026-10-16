import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  addedOrChanged,
  appendProvenance,
  readProvenance,
  signOutputs,
  snapshotDataFiles,
  traceInput,
  verifyChain,
} from "../src/provenance.ts";

const root = await mkdtemp(join(tmpdir(), "mastic-prov-"));
const chain = join(root, "provenance.jsonl");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function shaOf(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("溯源链", () => {
  it("每条接上一条,序号连续", async () => {
    const path = join(root, "chain-a.jsonl");
    await appendProvenance(path, { kind: "search", query: "找地铁客流数据", resultCount: 3 });
    await appendProvenance(path, { kind: "note", note: "第二条" });

    const entries = await readProvenance(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.prev, "genesis");
    assert.equal(entries[1]?.prev, entries[0]?.digest);
    assert.deepEqual(verifyChain(entries), { ok: true, length: 2 });
  });

  it("改一条,链就断在那儿 —— 这是「不可修改」能做到的程度", async () => {
    const path = join(root, "chain-b.jsonl");
    await appendProvenance(path, { kind: "fetch", url: "https://a.example/1.csv", sha256: "aa" });
    await appendProvenance(path, { kind: "fetch", url: "https://a.example/2.csv", sha256: "bb" });
    await appendProvenance(path, { kind: "fetch", url: "https://a.example/3.csv", sha256: "cc" });

    const entries = await readProvenance(path);
    // 把第 2 条的 url 偷偷换掉,摘要不动
    const tampered = [...entries];
    tampered[1] = { ...entries[1]!, url: "https://evil.example/x.csv" } as (typeof entries)[number];

    const check = verifyChain(tampered);
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 2, "应当指出断在第 2 条");
  });

  it("抽掉一条,后面全部对不上", async () => {
    const path = join(root, "chain-c.jsonl");
    await appendProvenance(path, { kind: "note", note: "1" });
    await appendProvenance(path, { kind: "note", note: "2" });
    await appendProvenance(path, { kind: "note", note: "3" });

    const entries = await readProvenance(path);
    const check = verifyChain([entries[0]!, entries[2]!]);
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 2);
  });

  it("空链也算通过", async () => {
    assert.equal(verifyChain([]).ok, true);
  });
});

/**
 * 这一组是这次要解决的根问题。模型特别爱造一份"看起来像那么回事"的数据把实验
 * 跑通 —— 拿随机数当观测、拿随机噪声图当输入。那种数据**没有来源**,
 * 而这条链能把它指出来。
 */
describe("实验输入能不能溯源", () => {
  it("从外部抓来的 → 可溯源", async () => {
    const path = join(root, "chain-fetch.jsonl");
    const data = join(root, "real.csv");
    await writeFile(data, "station,ridership\nA,1200\nB,980\n", "utf8");
    await appendProvenance(path, { kind: "fetch", url: "https://data.example/metro.csv", sha256: await shaOf(data) });

    const verdict = await traceInput(path, data);
    assert.equal(verdict.traceable, true);
    assert.equal(verdict.how, "fetched");
    assert.ok(verdict.detail.includes("data.example"));
  });

  it("用户提供的 → 可溯源", async () => {
    const path = join(root, "chain-user.jsonl");
    const data = join(root, "from-user.csv");
    await writeFile(data, "station,ridership\nC,77\n", "utf8");
    await appendProvenance(path, { kind: "user", sha256: await shaOf(data), path: "attachments/1.csv" });

    const verdict = await traceInput(path, data);
    assert.equal(verdict.traceable, true);
    assert.equal(verdict.how, "user");
  });

  /**
   * 这条就是核心。`write_file` 写出来的东西内容来自模型,不经过任何外部地址,
   * 所以它在链上找不到自己 —— 实验拿它当输入等于什么都没测。
   */
  it("模型自己编的 → 拦下,并说清为什么", async () => {
    const path = join(root, "chain-fake.jsonl");
    const fake = join(root, "made-up.csv");
    await writeFile(fake, "station,ridership\nX,999\nY,888\n", "utf8");
    // 链上只有别人的东西,没有这一份
    await appendProvenance(path, { kind: "fetch", url: "https://data.example/other.csv", sha256: "deadbeef" });

    const verdict = await traceInput(path, fake);
    assert.equal(verdict.traceable, false);
    assert.ok(verdict.detail.includes("找不到来源"));
    assert.ok(verdict.detail.includes("fetch_url"), "要告诉它怎么办");
  });

  it("先抓后改 → 也对不上,因为它已经不是那份数据了", async () => {
    const path = join(root, "chain-edit.jsonl");
    const data = join(root, "edited.csv");
    await writeFile(data, "a,b\n1,2\n", "utf8");
    await appendProvenance(path, { kind: "fetch", url: "https://data.example/e.csv", sha256: await shaOf(data) });

    await writeFile(data, "a,b\n1,999\n", "utf8"); // 事后改了
    const verdict = await traceInput(path, data);
    assert.equal(verdict.traceable, false);
  });

  it("随机生成的噪声数据也找不到来源", async () => {
    const path = join(root, "chain-noise.jsonl");
    const noise = join(root, "noise.csv");
    // 模拟 `np.random.rand` 那种:每次跑内容都不一样
    const rows = Array.from({ length: 20 }, () => Math.random().toFixed(6)).join("\n");
    await writeFile(noise, rows, "utf8");

    assert.equal((await traceInput(path, noise)).traceable, false);

    // 再"跑一次",内容变了 —— 即便有人把它记进链里,下次也对不上
    const again = Array.from({ length: 20 }, () => Math.random().toFixed(6)).join("\n");
    await writeFile(noise, again, "utf8");
    assert.equal((await traceInput(path, noise)).traceable, false);
  });

  it("读不到的文件也有话说,不抛异常", async () => {
    const verdict = await traceInput(chain, join(root, "并不存在.csv"));
    assert.equal(verdict.traceable, false);
    assert.ok(verdict.detail.includes("读不到"));
  });
});

describe("产出的签字", () => {
  it("扫出来的数据文件能前后对比出差集", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mastic-snap-"));
    try {
      await writeFile(join(dir, "old.csv"), "a,b\n1,2\n", "utf8");
      await writeFile(join(dir, "code.py"), "print(1)\n", "utf8");
      const before = await snapshotDataFiles(dir);

      await writeFile(join(dir, "new.csv"), "a,b\n3,4\n", "utf8");
      await writeFile(join(dir, "old.csv"), "a,b\n9,9\n", "utf8");
      const after = await snapshotDataFiles(dir);

      const produced = addedOrChanged(before, after);
      assert.deepEqual(
        produced.map((p) => p.path).sort(),
        ["new.csv", "old.csv"],
        "新增的和改过的都算产出;源码不算",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("产出的签字里带着任务号和命令号", async () => {
    const path = join(root, "chain-out.jsonl");
    const signed = await signOutputs(path, "T-003", [{ path: "out/run_times.json", sha256: "abc123" }], ["C5", "C8"]);

    assert.equal(signed.length, 1);
    assert.equal(signed[0]?.kind, "derived");
    assert.equal(signed[0]?.task, "T-003");
    assert.deepEqual(signed[0]?.commands, ["C5", "C8"]);
    assert.equal(verifyChain(await readProvenance(path)).ok, true);
  });

  it("产出的摘要进了链,于是它能被当输入引用", async () => {
    const path = join(root, "chain-out2.jsonl");
    const data = join(root, "result.csv");
    await writeFile(data, "x,y\n1,2\n", "utf8");
    const sha = await shaOf(data);

    await signOutputs(path, "T-001", [{ path: "result.csv", sha256: sha }], []);
    const verdict = await traceInput(path, data);
    assert.equal(verdict.traceable, true, "自己产出的数据,下游任务可以放心地用");
  });
});
