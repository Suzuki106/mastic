import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTaskDoc, renderTaskDoc } from "../src/doc/task.ts";
import { parseReportDoc, parseReportDraft } from "../src/doc/report.ts";
import { fatalFindings, lintReport } from "../src/doc/lint.ts";
import { validatePlan } from "../src/doc/plan.ts";

const VALID_TASK = `---
id: T-001
title: 给 lint 补一个禁词单测
goal: 确认「假设」会被拦下
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "npm test", expect: { exit_code: 0 } }
  - { kind: structural, require: [evidence_for_every_claim, no_forbidden_words] }
budget: { max_steps: 20 }
---

## 背景

无。
`;

describe("任务书解析", () => {
  it("收得下一份合法任务书", () => {
    const { task, errors } = parseTaskDoc(VALID_TASK);
    assert.deepEqual(errors, []);
    assert.equal(task?.id, "T-001");
    assert.equal(task?.acceptance.length, 2);
  });

  it("拒绝没有验收标准的任务", () => {
    const { task, errors } = parseTaskDoc(`---
id: T-001
title: 没有指标
goal: 空
deliverable: reports/T-001.md
budget: { max_steps: 10 }
---
`);
    assert.equal(task, undefined);
    assert.ok(errors.some((e) => e.includes("acceptance")));
  });

  it("拒绝一条判据都没写的 expect —— 那种验收会永远通过", () => {
    const { errors } = parseTaskDoc(`---
id: T-001
title: 空判据
goal: 空
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "true", expect: {} }
budget: { max_steps: 10 }
---
`);
    assert.ok(errors.some((e) => e.includes("一项判据都没有")));
  });

  it("挡住越界的 deliverable", () => {
    const { errors } = parseTaskDoc(`---
id: T-001
title: 越界
goal: 空
deliverable: ../outside.md
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
budget: { max_steps: 10 }
---
`);
    assert.ok(errors.length > 0);
  });

  it("往返一圈内容不丢", () => {
    const { task } = parseTaskDoc(VALID_TASK);
    assert.ok(task);
    const { task: again } = parseTaskDoc(renderTaskDoc(task));
    assert.deepEqual(again?.acceptance, task.acceptance);
    assert.equal(again?.body, task.body);
  });
});

describe("任务树校验", () => {
  it("抓出环", () => {
    const make = (id: string, deps: string[]) =>
      parseTaskDoc(`---
id: ${id}
title: ${id}
goal: ${id}
depends_on: [${deps.join(", ")}]
deliverable: reports/${id}.md
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
budget: { max_steps: 10 }
---
`).task!;

    assert.deepEqual(validatePlan([make("T-001", []), make("T-002", ["T-001"])]), []);
    const cyclic = validatePlan([make("T-001", ["T-002"]), make("T-002", ["T-001"])]);
    assert.ok(cyclic.some((problem) => problem.includes("环")));
    assert.ok(validatePlan([make("T-001", ["T-999"])]).some((p) => p.includes("不存在")));
  });
});

describe("报告草稿", () => {
  const DRAFT = `---
task: T-001
claims:
  - statement: 测试全过
    evidence:
      - { ref: C1 }
unresolved: []
---

## 做了什么
`;

  it("收得下引用了台账编号的草稿", () => {
    const { draft, errors } = parseReportDraft(DRAFT);
    assert.deepEqual(errors, []);
    assert.equal(draft?.claims[0]?.evidence[0]?.ref, "C1");
  });

  it("拒绝没有证据的 claim —— 这是反 mock 的第一道闸", () => {
    const { errors } = parseReportDraft(`---
task: T-001
claims:
  - statement: 我觉得应该没问题
    evidence: []
---
`);
    assert.ok(errors.some((e) => e.includes("没有任何证据")));
  });

  it("拒绝编造的编号格式", () => {
    const { errors } = parseReportDraft(`---
task: T-001
claims:
  - statement: 我跑过了
    evidence:
      - { ref: "随便写的" }
---
`);
    assert.ok(errors.some((e) => e.includes("台账编号")));
  });

  it("草稿里没有 status 这个字段 —— worker 没资格说完成", () => {
    const { draft } = parseReportDraft(DRAFT);
    assert.ok(draft);
    assert.equal("status" in draft, false);
  });
});

describe("禁词 lint", () => {
  const task = parseTaskDoc(VALID_TASK).task!;

  const reportWith = (body: string, allowTerms: string[] = []) => {
    const { report } = parseReportDoc(`---
task: T-001
status: unverified
claims:
  - statement: 测试全过
    evidence:
      - { kind: command, run: "npm test", cwd: ".", exit_code: 0, stdout_sha256: "abc" }
unresolved: []
---

${body}
`);
    assert.ok(report);
    return { report, task: { ...task, allow_terms: allowTerms } };
  };

  it("抓得到「假设」", () => {
    const { report, task: t } = reportWith("这里假设输入总是合法。");
    const findings = fatalFindings(lintReport(report, t), t);
    assert.ok(findings.some((f) => f.detail.includes("假设")));
  });

  it("抓得到英文的 assume / mock", () => {
    const { report, task: t } = reportWith("We assume the cache is warm.");
    assert.ok(lintReport(report, t).some((f) => f.detail.includes("assume")));
  });

  it("allow_terms 是唯一出口", () => {
    const { report, task: t } = reportWith("写了一个 mock server。", ["mock"]);
    const findings = lintReport(report, t).filter((f) => f.detail.includes("mock"));
    assert.deepEqual(findings, []);
  });

  it("干净的正文不产生 finding", () => {
    const { report, task: t } = reportWith("跑完 npm test,退出码 0。");
    assert.deepEqual(lintReport(report, t), []);
  });

  // 回归:真实跑 node --test 时,它的计数行里就有一行 `ℹ todo 0`。
  // 报告老老实实把它贴进代码块,结果被禁词表当成"作者在编" —— 这是误伤。
  it("引用不算主张:代码块里的 todo 不触发", () => {
    const { report, task: t } = reportWith("```\nℹ tests 4\nℹ todo 0\nℹ pass 4\n```\n");
    assert.deepEqual(lintReport(report, t), []);
  });

  it("引用不算主张:行内代码里的 mock 不触发", () => {
    const { report, task: t } = reportWith("命令是 `grep -E \"mock|todo\"` 这一条。");
    assert.deepEqual(lintReport(report, t), []);
  });

  it("但作者自己的话仍然要筛", () => {
    const { report, task: t } = reportWith("```\nℹ todo 0\n```\n\n这块我假设输入合法。");
    const findings = lintReport(report, t);
    assert.equal(findings.length, 1);
    assert.ok(findings[0]?.detail.includes("假设"));
  });
});
