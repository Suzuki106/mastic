import { describe, expect, it } from "vitest";
import type { TaskData } from "../api";
import { layoutLayers } from "./graph";

function task(id: string, depends: string[] = []): TaskData {
  return { id, depends_on: depends };
}

describe("任务树分层", () => {
  it("无依赖的排第一层,依赖都满足后才下沉", () => {
    const layers = layoutLayers([
      task("T-001"),
      task("T-002", ["T-001"]),
      task("T-003", ["T-001"]),
      task("T-004", ["T-002", "T-003"]),
    ]).map((layer) => layer.map((item) => item.id));

    expect(layers).toEqual([["T-001"], ["T-002", "T-003"], ["T-004"]]);
  });

  // 这一条来自真实的运行:planner 拆出两个独立模块 + 一个收口任务,
  // 它们本就该在第一层并排,而不是被误判成有环。
  it("互不依赖的任务并排在同一层", () => {
    const layers = layoutLayers([task("T-001"), task("T-002")]);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(2);
  });

  it("有环也不会死循环,剩下的兜底显示出来", () => {
    const layers = layoutLayers([task("A", ["B"]), task("B", ["A"])]);
    expect(layers.flat()).toHaveLength(2);
  });

  it("空输入给空数组", () => {
    expect(layoutLayers([])).toEqual([]);
  });
});
