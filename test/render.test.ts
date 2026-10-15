import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { renderDag, renderDoc, state } from "../src/web/app.js";
import { idsFromHtml, installDom, type FakeElement } from "./dom-shim.ts";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
const dom = installDom(idsFromHtml(html));

/** 形状照着 /api/runs/<id> 的真实返回写 —— 那是 curl 验过的。 */
function payload(status: string) {
  return {
    run: { id: "2026-10-15T11-51-08-29f2z4", goal: "实现 slugify", status: "done" },
    tasks: [
      {
        file: "T-001.md",
        doc: {
          data: {
            id: "T-001",
            title: "实现 slugify",
            goal: "让测试全过",
            depends_on: [],
            deliverable: "reports/T-001.md",
            acceptance: [
              { kind: "command", run: "npm test", expect: { exit_code: 0 } },
              { kind: "structural", require: ["evidence_for_every_claim"] },
            ],
            budget: { max_steps: 24 },
          },
          body: "## 背景\n\n仓库是纯 ESM。",
        },
      },
      { file: "T-002.md", doc: { data: { id: "T-002", title: "复核", depends_on: ["T-001"] }, body: "" } },
    ],
    reports: [
      {
        file: "T-001.md",
        doc: {
          data: {
            task: "T-001",
            status,
            claims: [
              {
                statement: "测试全过",
                evidence: [
                  { kind: "command", run: "npm test", exit_code: 0, stdout_sha256: "abcdef0123456789" },
                ],
              },
            ],
            files_changed: [{ path: "src/slugify.js", action: "created" }],
            unresolved: ["并发没验"],
            verdict: {
              decided_at: "2026-10-15T11:52:00.000Z",
              reasons: ["全部验收通过"],
              checks: [
                { kind: "command", label: "npm test", passed: true, detail: "退出码 0" },
                { kind: "evidence", label: "证据 `npm test`", passed: false, detail: "输出不是逐字节可复现的" },
              ],
            },
          },
          body: "## 做了什么\n\n写了 `slugify`。\n\n```\nexport function slugify(s) {}\n```",
        },
      },
    ],
  };
}

function render(status = "verified"): string {
  const data = payload(status);
  state.run = data.run;
  state.tasks = data.tasks;
  state.reports = data.reports;
  state.selected = "T-001";
  state.view = "report";
  renderDoc();
  return (dom.find("doc") as FakeElement).serialise();
}

describe("渲染交付报告", () => {
  it("状态、裁定、逐条判据都出来了", () => {
    const out = render();
    assert.ok(out.includes("已验证"), "缺状态标签");
    assert.ok(out.includes("全部验收通过"), "缺裁定理由");
    assert.ok(out.includes("退出码 0"), "缺判据明细");
  });

  it("通过的判据打勾,没过的打叉", () => {
    const out = render();
    assert.ok(out.includes("✓") && out.includes("✗"));
  });

  it("主张带着证据哈希一起显示", () => {
    const out = render();
    assert.ok(out.includes("测试全过"));
    assert.ok(out.includes("abcdef012345"), "证据哈希没渲染出来");
  });

  it("未解决项与改动清单都在", () => {
    const out = render();
    assert.ok(out.includes("并发没验"));
    assert.ok(out.includes("src/slugify.js"));
    assert.ok(out.includes("created"));
  });

  it("正文走 Markdown 渲染,代码块没被当成标题", () => {
    const out = render();
    assert.ok(out.includes("<pre><code>"));
    assert.ok(out.includes("写了 <code>slugify</code>"));
  });

  it("没有报告时给出提示而不是崩掉", () => {
    state.tasks = payload("verified").tasks;
    state.reports = [];
    state.selected = "T-001";
    state.view = "report";
    renderDoc();
    assert.ok((dom.find("doc") as FakeElement).serialise().includes("还没有交付报告"));
  });

  it("卡住的任务会显示 blocked_reason", () => {
    const data = payload("blocked");
    const report = data.reports[0];
    assert.ok(report?.doc.data);
    (report.doc.data as Record<string, unknown>).blocked_reason = "缺一个只有老板能给的凭据";
    state.run = data.run;
    state.tasks = data.tasks;
    state.reports = data.reports;
    state.selected = "T-001";
    state.view = "report";
    renderDoc();
    assert.ok((dom.find("doc") as FakeElement).serialise().includes("缺一个只有老板能给的凭据"));
  });

  it("切到任务书视图,显示目标与验收", () => {
    const data = payload("verified");
    state.run = data.run;
    state.tasks = data.tasks;
    state.reports = data.reports;
    state.selected = "T-001";
    state.view = "task";
    renderDoc();
    const out = (dom.find("doc") as FakeElement).serialise();
    assert.ok(out.includes("让测试全过"));
    assert.ok(out.includes("npm test"));
    assert.ok(out.includes("command"));
  });
});

describe("渲染任务树", () => {
  it("两个任务都建成节点,依赖画成一条边", () => {
    const data = payload("verified");
    state.tasks = data.tasks;
    state.reports = data.reports;
    state.selected = "T-001";
    renderDag();

    const stage = (dom.find("dag") as FakeElement).children[0];
    assert.ok(stage, "没有生成 stage");

    const nodes = stage.children.filter((child) => child.className.includes("node"));
    assert.equal(nodes.length, 2);

    const svg = stage.children.find((child) => child.tagName === "svg");
    assert.ok(svg, "没有生成 svg");
    assert.equal(svg.children.filter((child) => child.className === "edge").length, 1);
  });

  it("选中的节点带标记,状态进了 class", () => {
    state.tasks = payload("verified").tasks;
    state.reports = payload("verified").reports;
    state.selected = "T-001";
    renderDag();

    const stage = (dom.find("dag") as FakeElement).children[0];
    const node = stage?.children.find((child) => child.className.includes("status-"));
    assert.ok(node?.className.includes("is-selected"));
    assert.ok(node?.className.includes("status-verified"));
  });
});
