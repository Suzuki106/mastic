import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compareNumeric, runReproducibleChecks, withOut } from "../src/check/reproduce.ts";
import { parseTaskDoc, type TaskDoc } from "../src/doc/task.ts";

const workspace = await mkdtemp(join(tmpdir(), "mastic-repro-"));
after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function task(run: string, mode = "numeric"): TaskDoc {
  const { task: parsed } = parseTaskDoc(`---
id: T-001
title: 复现
goal: 测
deliverable: reports/T-001.md
acceptance:
  - kind: reproducible
    run: >-
      ${run}
    runs: 2
    compare:
      - { path: "{out}/m.json", mode: ${mode}, tolerance: 1e-6 }
---
`);
  assert.ok(parsed, "任务书应当解析得动");
  return parsed;
}

describe("数值比对", () => {
  it("完全相等", () => {
    assert.equal(compareNumeric({ a: 1 }, { a: 1 }, 1e-6), null);
  });

  it("容差之内算一致 —— 浮点训练本来就不可能逐字节相同", () => {
    assert.equal(compareNumeric({ a: 0.93 }, { a: 0.93 + 1e-9 }, 1e-6), null);
  });

  it("容差之外算不一致,并指出是哪个字段", () => {
    const problem = compareNumeric({ nested: { acc: 0.93 } }, { nested: { acc: 0.91 } }, 1e-6);
    assert.ok(problem);
    assert.ok(problem.path.includes("acc"), `应当指到 acc,实际 ${problem?.path}`);
  });

  it("缺字段、多字段都算不一致", () => {
    assert.ok(compareNumeric({ a: 1 }, { a: 1, b: 2 }, 1e-6)?.detail.includes("多出"));
    assert.ok(compareNumeric({ a: 1, b: 2 }, { a: 1 }, 1e-6)?.detail.includes("缺"));
  });

  it("数组长度不同算不一致", () => {
    assert.ok(compareNumeric([1, 2], [1, 2, 3], 1e-6)?.detail.includes("长度"));
  });
});

describe("把实验再做一遍", () => {
  it("{out} 换成每遍各自的目录", () => {
    assert.equal(withOut("python x.py --out {out}", 2), "python x.py --out repro-2");
  });

  it("确定性实验两遍一致 → 通过", async () => {
    const outcomes = await runReproducibleChecks(
      task(`mkdir -p {out} && printf '{"acc":0.93}\\n' > {out}/m.json`),
      { workspace, timeoutMs: 20_000 },
    );
    assert.equal(outcomes[0]?.passed, true, outcomes[0]?.detail);
  });

  /**
   * 这条才是关键 —— 也是之前完全没有的检查。
   * "证据重放"只能证明记录忠实于当前世界;这里证明的是这套实验能不能重做。
   */
  it("带随机数的实验两遍不同 → 不通过", async () => {
    const outcomes = await runReproducibleChecks(
      task(`mkdir -p {out} && printf '{"acc":%s}\\n' "$(date +%N)" > {out}/m.json`),
      { workspace, timeoutMs: 20_000 },
    );
    assert.equal(outcomes[0]?.passed, false);
    assert.ok(outcomes[0]?.detail.includes("数值对不上"));
  });

  it("第一遍就失败 → 不通过", async () => {
    const outcomes = await runReproducibleChecks(task("mkdir -p {out} && exit 3"), { workspace, timeoutMs: 20_000 });
    assert.equal(outcomes[0]?.passed, false);
    assert.ok(outcomes[0]?.detail.includes("退出码 3"));
  });

  it("要求 exact 时,差一个字节就不行", async () => {
    const outcomes = await runReproducibleChecks(
      task(`mkdir -p {out} && printf '{"acc":%s}\\n' "$(date +%N)" > {out}/m.json`, "exact"),
      { workspace, timeoutMs: 20_000 },
    );
    assert.equal(outcomes[0]?.passed, false);
    assert.ok(outcomes[0]?.detail.includes("字节不同"));
  });
});
