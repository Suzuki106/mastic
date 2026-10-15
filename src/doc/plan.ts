import type { TaskDoc } from "./task.ts";

/** 检查任务树的形状:编号唯一、依赖存在、无环。返回空数组表示没问题。 */
export function validatePlan(tasks: TaskDoc[]): string[] {
  const problems: string[] = [];

  if (tasks.length === 0) {
    return ["任务树是空的 —— 目标没有被拆成任何可执行的东西。"];
  }

  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) problems.push(`任务编号 \`${task.id}\` 重复了。`);
    seen.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (dependency === task.id) {
        problems.push(`\`${task.id}\` 依赖自己。`);
      } else if (!seen.has(dependency)) {
        problems.push(`\`${task.id}\` 依赖了不存在的任务 \`${dependency}\`。`);
      }
    }
  }

  // 判环要看**排进去了几个任务**,不是分了几层。
  // 拿层数跟任务数比会冤枉每一个正常的多层 DAG:
  // A ← B、A ← C 是两层三个任务,2 < 3,会被误报成有环。
  const placed = topoLayers(tasks).reduce((sum, layer) => sum + layer.length, 0);
  if (problems.length === 0 && placed < tasks.length) {
    problems.push("依赖关系里存在环,没法排出执行顺序。");
  }

  return problems;
}

/**
 * 按依赖分层:同一层里的任务互不依赖,可以并行跑。
 *
 * 有环时会在环上停下并返回已有的层(不抛错)—— 调用方应当先用 validatePlan 挡住,
 * 这里只是保证「有环也不会死循环」。
 */
export function topoLayers(tasks: TaskDoc[]): TaskDoc[][] {
  const remaining = new Set(tasks.map((task) => task.id));
  const layers: TaskDoc[][] = [];

  while (remaining.size > 0) {
    const layer = tasks.filter(
      (task) => remaining.has(task.id) && task.depends_on.every((dep) => !remaining.has(dep)),
    );

    if (layer.length === 0) break;

    for (const task of layer) remaining.delete(task.id);
    layers.push(layer);
  }

  return layers;
}
