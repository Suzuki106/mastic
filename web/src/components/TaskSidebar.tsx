import type { TaskData } from "../api";
import { layoutLayers } from "../lib/graph";
import { statusOf } from "../lib/status";

export interface TaskSidebarProps {
  tasks: TaskData[];
  statusOfTask: (taskId: string) => string;
  /** 当前视口里那一节,由滚动位置推出来。 */
  active: string | null;
  onJump: (taskId: string) => void;
}

/**
 * 任务侧栏。
 *
 * 之前这里是一张图画布,问题是它只擅长"看关系",不擅长"读内容" ——
 * 点一个任务中间就整个换掉,看不到全局,也没法顺着往下读。
 *
 * 现在它像文档站的目录:**任务按依赖深度缩进**,点一下内容跳到对应那一节。
 * 依赖关系仍然看得出来(缩进 + 左侧那条竖线),但主要用途变成了导航。
 */
export function TaskSidebar({ tasks, statusOfTask, active, onJump }: TaskSidebarProps) {
  if (tasks.length === 0) {
    return (
      <div className="px-4 py-6 text-[12.5px] leading-relaxed text-faint">
        还没有任务书。
        <br />
        planner 交卷后,任务会出现在这里。
      </div>
    );
  }

  const layers = layoutLayers(tasks);

  return (
    <nav className="px-2 py-2">
      {layers.map((layer, depth) => (
        <div key={depth} className="relative">
          {/* 缩进用一条竖线表示,比纯空白更能看出层级 */}
          {depth > 0 && <span className="absolute top-0 bottom-0 left-[7px] w-px bg-line" />}

          <div style={{ paddingLeft: depth * 12 }}>
            {layer.map((task) => {
              const status = statusOfTask(task.id);
              const info = statusOf(status);
              const { Icon } = info;
              const isActive = active === task.id;

              return (
                <button
                  key={task.id}
                  onClick={() => onJump(task.id)}
                  title={task.title ?? task.id}
                  className={`group mb-0.5 flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    isActive ? "bg-slate-100" : "hover:bg-slate-50"
                  }`}
                >
                  <Icon
                    size={13}
                    className={`mt-[3px] shrink-0 ${
                      status === "running" ? "animate-breathe text-running" : "text-current"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span
                        className={`font-mono text-[11px] font-semibold ${
                          isActive ? "text-slate-900" : "text-slate-500"
                        }`}
                      >
                        {task.id}
                      </span>
                      <span className="truncate text-[10.5px] text-faint">{info.label}</span>
                    </span>
                    <span
                      className={`mt-0.5 line-clamp-2 block text-[12px] leading-snug ${
                        isActive ? "text-slate-700" : "text-slate-500"
                      }`}
                    >
                      {task.title ?? ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
