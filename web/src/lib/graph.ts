import type { TaskData } from "../api";

/**
 * 按 `depends_on` 分层:同一层里的任务互不依赖,是真的可以并行跑的。
 *
 * 界面用这个来摆位置。它和后端 `src/doc/plan.ts` 里的 topoLayers 是同一套规则,
 * 但**不能共用一个实现** —— 后端那份跑在 Node 里,这份跑在浏览器里,
 * 中间没有构建期共享代码的通道。两边都简单到不会漂移。
 */
export function layoutLayers(tasks: TaskData[]): TaskData[][] {
  const remaining = new Set(tasks.map((task) => task.id));
  const layers: TaskData[][] = [];

  while (remaining.size > 0) {
    const layer = tasks.filter(
      (task) => remaining.has(task.id) && (task.depends_on ?? []).every((dep) => !remaining.has(dep)),
    );

    // 有环就停下,别死循环 —— 剩下的任务交给调用方兜底显示
    if (layer.length === 0) break;

    for (const task of layer) remaining.delete(task.id);
    layers.push(layer);
  }

  if (remaining.size > 0) {
    layers.push(tasks.filter((task) => remaining.has(task.id)));
  }

  return layers;
}
