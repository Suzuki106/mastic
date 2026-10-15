import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPool } from "../src/orchestrator.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("并发闸门", () => {
  it("每个任务都跑到,顺序不限", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it("同时最多只跑 limit 个", async () => {
    let running = 0;
    let peak = 0;

    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });

    assert.equal(peak, 2, `并发峰值应当是 2,实际 ${peak}`);
  });

  it("limit 比任务数还大时不会空转", async () => {
    const gate = deferred();
    let started = 0;

    const all = runPool([1, 2], 99, async () => {
      started += 1;
      await gate.promise;
    });

    // 两个都该立刻起来 —— 闸门不该因为 limit 大就少放人
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, 2);

    gate.resolve();
    await all;
  });

  it("空列表直接返回,不死循环", async () => {
    await runPool([], 3, async () => {
      throw new Error("不该被调用");
    });
  });

  it("某一个抛错会向上冒 —— 不吞掉失败", async () => {
    await assert.rejects(
      runPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("第 2 个炸了");
      }),
      /第 2 个炸了/,
    );
  });
});
