import { isAbsolute, relative, resolve } from "node:path";

export class PathEscapeError extends Error {
  constructor(target: string) {
    super(`路径 \`${target}\` 跑到工作目录外面去了,拒绝执行。`);
    this.name = "PathEscapeError";
  }
}

/**
 * 把路径钉在工作目录内。
 *
 * 任务书和证据里的路径都是模型写的,不可信 —— 绝对路径、`..` 都得挡掉,
 * 否则一个跑偏的任务书就能让 agent 读写工作目录之外的文件。
 */
export function resolveInside(workspace: string, target: string): string {
  const base = resolve(workspace);
  const full = isAbsolute(target) ? resolve(target) : resolve(base, target);
  const rel = relative(base, full);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(target);
  }

  return full;
}

/** 给日志和文档用的、相对工作目录的短路径。 */
export function displayPath(workspace: string, full: string): string {
  const rel = relative(resolve(workspace), full);
  return rel === "" ? "." : rel;
}
