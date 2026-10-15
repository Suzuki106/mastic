import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideStatus, type VerdictInput } from "../src/check/verdict.ts";
import type { CommandCheckOutcome } from "../src/check/run.ts";
import type { ReplayOutcome } from "../src/check/replay.ts";

function base(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    commandOutcomes: [],
    replayOutcomes: [],
    fatalLint: [],
    statementVerdicts: [],
    unresolved: [],
    noUnresolvedRequired: false,
    ...overrides,
  };
}

const passingCommand: CommandCheckOutcome = {
  check: { kind: "command", run: "npm test", expect: { exit_code: 0 } },
  passed: true,
  detail: "退出码 0",
};

const replayed: ReplayOutcome = { claimIndex: 0, evidenceIndex: 0, verdict: "replayed", detail: "对上了" };

describe("定状态", () => {
  it("全过 → verified", () => {
    const verdict = decideStatus(
      base({ commandOutcomes: [passingCommand], replayOutcomes: [replayed] }),
    );
    assert.equal(verdict.status, "verified");
  });

  it("验收没过 → contradicted", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [{ ...passingCommand, passed: false, detail: "退出码是 1,期望 0" }],
        replayOutcomes: [replayed],
      }),
    );
    assert.equal(verdict.status, "contradicted");
    assert.ok(verdict.reasons[0]?.includes("退出码是 1"));
  });

  it("证据重放对不上 → contradicted", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [{ ...replayed, verdict: "contradicted", detail: "重放退出码是 1" }],
      }),
    );
    assert.equal(verdict.status, "contradicted");
  });

  it("输出漂移只是软伤 → unverified,而不是指控 worker 说谎", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [{ ...replayed, verdict: "drifted", detail: "输出不是逐字节可复现" }],
      }),
    );
    assert.equal(verdict.status, "unverified");
  });

  it("URL 证据不可重放 → unverified", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [{ ...replayed, verdict: "unreplayable", detail: "随时间变" }],
      }),
    );
    assert.equal(verdict.status, "unverified");
  });

  it("有未解决项,但任务没要求清干净 → unverified(合法终态)", () => {
    const verdict = decideStatus(
      base({ commandOutcomes: [passingCommand], replayOutcomes: [replayed], unresolved: ["并发没验"] }),
    );
    assert.equal(verdict.status, "unverified");
  });

  it("任务要求 no_unresolved 时,留尾巴就是硬伤", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [replayed],
        unresolved: ["并发没验"],
        noUnresolvedRequired: true,
      }),
    );
    assert.equal(verdict.status, "contradicted");
  });

  it("陈述没被支撑 → contradicted", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [replayed],
        statementVerdicts: [{ statement: "没有新增依赖", supported: false, detail: "报告没提依赖" }],
      }),
    );
    assert.equal(verdict.status, "contradicted");
  });

  it("worker 主动喊停 → blocked,即使别的都过了", () => {
    const verdict = decideStatus(
      base({
        commandOutcomes: [passingCommand],
        replayOutcomes: [replayed],
        blockedReason: "缺一个只有老板能给的凭据",
      }),
    );
    assert.equal(verdict.status, "blocked");
    assert.ok(verdict.reasons[0]?.includes("凭据"));
  });
});
