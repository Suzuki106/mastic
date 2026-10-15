import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../api";
import { EventStream } from "./EventStream";

function event(seq: number, kind: string, detail: string, task?: string): RunEvent {
  return {
    seq,
    at: `2026-10-15T12:00:${String(seq).padStart(2, "0")}.000Z`,
    run: "r",
    kind,
    detail,
    ...(task === undefined ? {} : { task }),
  };
}

const EVENTS: RunEvent[] = [
  event(1, "run_start", "目标 写个 slugify"),
  event(2, "task_step", "run_bash → C1 | 退出码 0 | 80ms", "T-001"),
  event(3, "task_step", "write_file → F2 | 已写入 src/slugify.js", "T-001"),
  event(4, "task_verdict", "verified —— 全部验收通过,且每条证据都重放成功", "T-001"),
  event(5, "run_done", "完成 verified 1"),
];

function render(events: RunEvent[] = EVENTS): string {
  return renderToStaticMarkup(<EventStream events={events} live />);
}

describe("事件流", () => {
  /**
   * 这条是被真实使用纠正过来的:一开始我默认只显示"关键"事件,结果 planner
   * 想十分钟、期间全是过程事件,屏幕上就只剩一条 run_start 一动不动 —— 看着
   * 像死了。现在一条事件只占一行,铺出来不挤,默认就全显示。
   */
  it("默认全显示 —— 过程事件才是「正在发生什么」", () => {
    const html = render();
    expect(html).toContain("已写入 src/slugify.js");
    expect(html).toContain("run_bash");
    expect(html).toContain("全部验收通过");
    expect(html).toContain("目标 写个 slugify");
  });

  it("计数写的是总数", () => {
    expect(render()).toContain("全部 5");
  });

  it("裁定把状态和理由分开,状态单独可辨", () => {
    const html = render();
    expect(html).toContain("verified");
    expect(html).toContain("全部验收通过");
  });

  it("没有事件时给提示,不是空白", () => {
    expect(render([])).toContain("还没有事件");
  });

  it("时间戳只显示到秒", () => {
    expect(render()).toContain("12:00:01");
  });

  /**
   * 推理期间模型一个字的 content 都不吐。以前这里什么都不发,界面全黑;
   * 后来改成每 4 秒灌一条,结果十分钟想出 25 条几乎一样的记录,把真事淹了。
   * 现在是一次调用两条,活着的感觉交给这颗自己走的秒表。
   */
  it("最后一条是 thinking 时,渲染成会走秒表的进行中行", () => {
    const html = render([...EVENTS, event(6, "thinking", "正在请求模型…", "planner")]);
    expect(html).toContain("正在思考");
    expect(html).toContain("s</span>");
  });

  /**
   * 后端推的是**增量**,不是切片。这里必须把它们接起来 ——
   * 之前每条各显示一段、后者取代前者,用户每 8 秒看到一块碎片,永远拼不成句子。
   */
  it("连续的 thinking 拼成一块完整思路,而不是只留最后一段", () => {
    const html = render([
      event(1, "run_start", "开始"),
      event(2, "thinking", "先看仓库结构。", "planner"),
      event(3, "thinking", "它是空的,所以要全新搭建。", "planner"),
      event(4, "thinking", "那就先冻结边界和指标。", "planner"),
    ]);
    expect(html).toContain("先看仓库结构。");
    expect(html).toContain("它是空的,所以要全新搭建。");
    expect(html).toContain("那就先冻结边界和指标。");
  });

  it("中间隔了别的事件就分开 —— 那是两次不同的思考", () => {
    const html = render([
      event(1, "thinking", "第一次思考", "planner"),
      event(2, "task_step", "list_dir → 看了一圈", "planner"),
      event(3, "thinking", "第二次思考", "planner"),
    ]);
    expect(html).toContain("第一次思考");
    expect(html).toContain("第二次思考");
  });

  it("不同任务的 thinking 也分开", () => {
    const html = render([
      event(1, "thinking", "T-001 在想", "T-001"),
      event(2, "thinking", "T-002 在想", "T-002"),
    ]);
    expect(html).toContain("T-001 在想");
    expect(html).toContain("T-002 在想");
  });

  it("思考那一行是可点的,并且给出展开提示", () => {
    const html = render([event(1, "run_start", "开始"), event(2, "thinking", "在想事情", "planner")]);
    expect(html).toContain("<button");
    expect(html).toContain("展开");
  });

  it("thinking 不再是最后一条时,退回成普通行,秒表停", () => {
    const html = render([event(1, "thinking", "正在请求模型…", "planner"), event(2, "run_done", "完成")]);
    expect(html).not.toContain("正在思考");
    expect(html).toContain("正在请求模型");
  });
});
