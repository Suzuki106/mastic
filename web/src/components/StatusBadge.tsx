import { badgeClass, statusOf } from "../lib/status";

export function StatusBadge({ status, running }: { status: string; running?: boolean }) {
  const info = statusOf(running === true ? "running" : status);
  const { Icon } = info;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12px] font-medium ${badgeClass(
        running === true ? "running" : status,
      )}`}
    >
      <Icon size={13} className={running === true ? "animate-breathe" : undefined} />
      {running === true ? "在跑" : info.label}
    </span>
  );
}
