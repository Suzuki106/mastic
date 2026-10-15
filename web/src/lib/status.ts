import type { ComponentType } from "react";
import {
  BlockedIcon,
  ContradictedIcon,
  FailedIcon,
  PendingIcon,
  RunningIcon,
  SkippedIcon,
  UnverifiedIcon,
  VerifiedIcon,
} from "../icons";

/**
 * 状态只有一个出处。
 *
 * 任务树上的点、徽章、判据标记,全都从这张表取颜色和图标 ——
 * 同一个状态在界面上任何地方都必须长一样,否则读的人要重新学一遍。
 */
export const STATUS = {
  verified: { label: "已验证", color: "verified", Icon: VerifiedIcon },
  unverified: { label: "未验全", color: "unverified", Icon: UnverifiedIcon },
  contradicted: { label: "对不上", color: "contradicted", Icon: ContradictedIcon },
  blocked: { label: "卡住", color: "blocked", Icon: BlockedIcon },
  failed: { label: "没交卷", color: "failed", Icon: FailedIcon },
  skipped: { label: "跳过了", color: "skipped", Icon: SkippedIcon },
  running: { label: "在跑", color: "running", Icon: RunningIcon },
  done: { label: "已完成", color: "verified", Icon: VerifiedIcon },
  pending: { label: "待跑", color: "pending", Icon: PendingIcon },
} as const;

export type StatusKey = keyof typeof STATUS;

export function statusOf(status: string | undefined): (typeof STATUS)[StatusKey] {
  if (status !== undefined && status in STATUS) return STATUS[status as StatusKey];
  return STATUS.pending;
}

/** 徽章配色。白底上这几个颜色都是按对比度挑过的。 */
export const BADGE_STYLE: Record<string, string> = {
  verified: "text-verified border-verified/35 bg-verified/8",
  unverified: "text-unverified border-unverified/35 bg-unverified/8",
  contradicted: "text-contradicted border-contradicted/35 bg-contradicted/8",
  blocked: "text-blocked border-blocked/35 bg-blocked/8",
  failed: "text-contradicted border-contradicted/35 bg-contradicted/8",
  skipped: "text-faint border-line-strong bg-slate-50",
  running: "text-running border-running/35 bg-running/8",
  pending: "text-faint border-line-strong bg-slate-50",
};

/** 任务树节点左侧那条竖线的颜色。 */
export const EDGE_COLOR: Record<string, string> = {
  verified: "border-l-verified",
  unverified: "border-l-unverified",
  contradicted: "border-l-contradicted",
  blocked: "border-l-blocked",
  failed: "border-l-contradicted",
  skipped: "border-l-line-strong",
  running: "border-l-running",
  pending: "border-l-line-strong",
};

export function badgeClass(status: string | undefined): string {
  const key = status !== undefined && status in BADGE_STYLE ? status : "pending";
  return BADGE_STYLE[key] ?? BADGE_STYLE.pending ?? "";
}

export function edgeClass(status: string | undefined): string {
  const key = status !== undefined && status in EDGE_COLOR ? status : "pending";
  return EDGE_COLOR[key] ?? "";
}

/** 事件流里按事件类型上色。 */
export function eventTone(kind: string): string {
  if (kind === "task_verdict") return "text-ink";
  if (kind === "run_start" || kind === "run_done") return "text-verified";
  if (kind === "task_retry") return "text-unverified";
  if (kind === "task_skipped") return "text-faint";
  // 模型自己说的话比工具调用有信息量 —— 它在交代思路,别和读文件一个分量
  if (kind === "assistant") return "text-slate-700";
  if (kind === "thinking") return "text-running";
  return "text-muted";
}

export type IconComponent = ComponentType<{ size?: number | string; className?: string }>;
