import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../api";
import { EventStream } from "./EventStream";

function event(seq: number, kind: string, detail: string, task?: string): RunEvent {
  return { seq, at: `2026-10-15T12:00:${String(seq).padStart(2, "0")}.000Z`, run: "r", kind, detail, ...(task === undefined ? {} : { task }) };
}

const EVENTS: RunEvent[] = [
  event(1, "run_start", "目标 写个 slugify"),
  event(2, "task_step", "run_bash → C1 | 退出码 0 | 80ms --- stdout --- 一坨很长的输出…", "T-001"),
  event(3, "task_step", "write_file → F2 | 已写入 src/slugify.js", "T-001"),
  event(4, "task_verdict", "verified —— 全部验收通过,且每条证据都重放成功", "T-001"),
  event(5, "run_done", "完成 verified 1"),
];

function render(events: RunEvent[] = EVENTS): string {
  return renderToStaticMarkup(<EventStream events={events} live />);
}

describe("事件流", () => {
  // 一次运行里工具调用占八九成;全铺出来会把裁定淹掉,而那才是要看的
  it("默认只显示关键事件,过程事件收起来", () => {
    const html = render();
    expect(html).toContain("全部验收通过");
    expect(html).toContain("目标 写个 slugify");
    expect(html).not.toContain("C1 | 退出码 0");
    expect(html).not.toContain("已写入 src/slugify.js");
  });

  it("收起来几条要写出来,不然用户不知道有东西被藏了", () => {
    expect(render()).toContain("只看关键 (2)");
  });

  it("没有过程事件时不显示计数", () => {
    const html = render([event(1, "run_start", "开始"), event(2, "run_done", "完成")]);
    expect(html).toContain("只看关键");
    expect(html).not.toContain("只看关键 (");
  });

  it("裁定把状态和理由分开,状态单独可辨", () => {
    const html = render();
    expect(html).toContain("verified");
    expect(html).toContain("全部验收通过");
  });

  it("钉一条最新的,省得为了知道进度去盯滚动条", () => {
    const html = render();
    expect(html).toContain("完成 verified 1");
  });

  it("没有事件时给提示,不是空白", () => {
    expect(render([])).toContain("还没有事件");
  });

  it("只剩过程事件时说明白怎么看到它们", () => {
    const html = render([event(1, "task_step", "run_bash → 退出码 0", "T-001")]);
    expect(html).toContain("点右上角");
  });

  it("时间戳只显示到秒", () => {
    expect(render()).toContain("12:00:01");
  });
});
