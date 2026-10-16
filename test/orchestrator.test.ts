import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateSteps, runPool } from "../src/orchestrator.ts";

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

/**
 * 预算分配。
 *
 * 这一组盯的是一个原则:**分配规则必须是固定的算式,不能是模型报的数。**
 * 原先每份任务书里写着 planner 拍的 `max_steps`,而那个数没有刻度 ——
 * 它这次的"30"和下次的"30"对应的难度不是一个东西,而**不可比的数
 * 不能用来分配资源**。
 */
describe("步数分配", () => {
  it("剩余预算平摊给还没开始的任务", () => {
    assert.equal(allocateSteps(400, 8, 80), 50);
    assert.equal(allocateSteps(400, 4, 80), 80, "算出来超过硬顶就压到硬顶");
  });

  it("剩余越少,分得越少 —— 先做的占便宜,这是有意的", () => {
    assert.equal(allocateSteps(400, 8, 80), 50);
    assert.equal(allocateSteps(100, 8, 80), 12);
    assert.equal(allocateSteps(16, 8, 80), 2);
  });

  it("再紧也至少给一步,不然任务连交卷的机会都没有", () => {
    assert.equal(allocateSteps(0, 5, 80), 1);
    assert.equal(allocateSteps(-10, 5, 80), 1);
  });

  it("没有剩余任务时给硬顶(边界,实际用不到)", () => {
    assert.equal(allocateSteps(400, 0, 80), 80);
  });
});
