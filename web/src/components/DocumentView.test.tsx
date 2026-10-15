import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocEntry, ReportData, TaskData } from "../api";
import { DocumentView } from "./DocumentView";

function taskEntry(data: Partial<TaskData>): DocEntry<TaskData> {
  return {
    file: "T-001.md",
    doc: {
      data: { id: "T-001", title: "写个函数", goal: "让测试过", ...data },
      body: "## 正文\n\n说明。",
    },
  };
}

function reportEntry(data: Partial<ReportData>): DocEntry<ReportData> {
  return {
    file: "T-001.md",
    doc: {
      data: {
        task: "T-001",
        status: "verified",
        claims: [],
        files_changed: [],
        unresolved: [],
        ...data,
      },
      body: "",
    },
  };
}

function render(
  task: DocEntry<TaskData> | undefined,
  report: DocEntry<ReportData> | undefined,
  view: "report" | "task" = "report",
): string {
  return renderToStaticMarkup(
    <DocumentView task={task} report={report} view={view} onView={() => {}} />,
  );
}

describe("文档视图", () => {
  it("任务书视图列出验收标准", () => {
    const html = render(
      taskEntry({
        acceptance: [
          { kind: "command", run: "npm test", expect: { exit_code: 0 } },
          { kind: "structural", require: ["evidence_for_every_claim"] },
        ],
      }),
      undefined,
      "task",
    );
    expect(html).toContain("npm test");
    expect(html).toContain("command");
    expect(html).toContain("evidence_for_every_claim");
  });

  // 三态必须长得不一样 —— 把"过了但有话要说"画成叉,读的人会以为没验过
  it("裁定三态各有各的颜色", () => {
    const html = render(
      taskEntry({}),
      reportEntry({
        verdict: {
          decided_at: "2026-10-15T00:00:00.000Z",
          reasons: ["全部验收通过"],
          checks: [
            { kind: "command", label: "npm test", passed: true, detail: "退出码 0" },
            { kind: "evidence", label: "证据 A", passed: true, caveat: true, detail: "输出不逐字节可复现" },
            { kind: "evidence", label: "证据 B", passed: false, detail: "对不上" },
          ],
        },
      }),
    );

    expect(html).toContain("text-verified");
    expect(html).toContain("text-unverified");
    expect(html).toContain("text-contradicted");
    expect(html).toContain("全部验收通过");
  });

  it("卡住的原因写在最显眼的地方", () => {
    const html = render(taskEntry({}), reportEntry({ status: "blocked", blocked_reason: "缺一个凭据" }));
    expect(html).toContain("缺一个凭据");
  });

  it("未解决项和改动清单都渲染出来", () => {
    const html = render(
      taskEntry({}),
      reportEntry({
        unresolved: ["并发没验"],
        files_changed: [{ path: "src/a.ts", action: "created" }],
      }),
    );
    expect(html).toContain("并发没验");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("created");
  });

  it("主张带着证据一起显示", () => {
    const html = render(
      taskEntry({}),
      reportEntry({
        claims: [
          {
            statement: "测试全过",
            evidence: [{ kind: "command", run: "npm test", exit_code: 0, stdout_sha256: "abcdef0123456789" }],
          },
        ],
      }),
    );
    expect(html).toContain("测试全过");
    expect(html).toContain("abcdef012345");
  });

  it("没有报告时给提示而不是崩掉", () => {
    const html = render(taskEntry({}), undefined);
    expect(html).toContain("还没有交付报告");
  });

  it("什么都没选时给提示", () => {
    expect(render(undefined, undefined)).toContain("左边点一个任务");
  });
});
