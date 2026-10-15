/**
 * app.js 的类型声明。
 *
 * 前端这三个文件必须是 .js —— 浏览器直接加载,没有构建步骤。这个 .d.ts 让
 * 测试能带类型地 import 它,同时把「服务端该喂给前端什么形状」写死在类型里。
 */

/** 一份文档:服务端已经替前端把 frontmatter 和正文拆开了。 */
export interface DocEntry {
  file: string;
  doc: { data: Record<string, unknown> | null; body: string } | null;
}

export interface AppState {
  runId: string | null;
  run: Record<string, unknown> | null;
  tasks: DocEntry[];
  reports: DocEntry[];
  selected: string | null;
  view: "report" | "task";
}

/** 分层只用到这两个字段。 */
export interface TaskMeta {
  id: string;
  depends_on?: string[];
}

export function escapeHtml(text: unknown): string;
export function renderMarkdown(source: unknown): string;
export function layout(meta: TaskMeta[]): TaskMeta[][];
export function renderDag(): void;
export function renderDoc(): void;
export const state: AppState;
