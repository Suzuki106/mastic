import { describe, expect, it } from "vitest";
import { badgeClass, edgeClass, eventTone, statusOf } from "./status";

describe("状态词汇表", () => {
  it("认识后端会给出的每一个状态", () => {
    expect(statusOf("verified").label).toBe("已验证");
    expect(statusOf("unverified").label).toBe("未验全");
    expect(statusOf("contradicted").label).toBe("对不上");
    expect(statusOf("blocked").label).toBe("卡住");
  });

  it("不认识的状态退回待跑,而不是渲染成空白", () => {
    expect(statusOf(undefined).label).toBe("待跑");
    expect(statusOf("未来才有的状态").label).toBe("待跑");
    expect(badgeClass("未来才有的状态")).toBe(badgeClass("pending"));
  });

  it("三个终态各有各的颜色 —— 同色就分不出来了", () => {
    const colors = ["verified", "unverified", "contradicted"].map(badgeClass);
    expect(new Set(colors).size).toBe(3);
  });

  it("任务树左侧竖线也跟着状态走", () => {
    expect(edgeClass("verified")).not.toBe(edgeClass("contradicted"));
    expect(edgeClass(undefined)).toBe(edgeClass("pending"));
  });

  it("事件流按类型分色", () => {
    expect(eventTone("run_done")).not.toBe(eventTone("task_step"));
    expect(eventTone("task_retry")).not.toBe(eventTone("task_verdict"));
  });
});
