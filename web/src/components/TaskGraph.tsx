import { Background, Controls, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { TaskData } from "../api";
import { layoutLayers } from "../lib/graph";
import { edgeClass, statusOf } from "../lib/status";

const NODE_WIDTH = 208;
const NODE_HEIGHT = 66;
const GAP_X = 92;
const GAP_Y = 22;

interface TaskNodeData extends Record<string, unknown> {
  taskId: string;
  title: string;
  status: string;
  selected: boolean;
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const info = statusOf(data.status);
  const { Icon } = info;

  return (
    // animate-pop 只在节点第一次插进 DOM 时播一次;之后状态变化只是换颜色,
    // 不会重播 —— 所以待办列表往上长的时候不会满屏乱闪。
    <div
      className={`animate-pop w-[208px] rounded-xl border border-line bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-[box-shadow,border-color] duration-200 ${
        data.selected ? "border-running ring-2 ring-running/25" : "border-line hover:border-line-strong"
      } border-l-[3px] ${edgeClass(data.status)}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="shrink-0 text-current" />
        <span className="font-mono text-[11px] font-semibold text-slate-900">{data.taskId}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-slate-600">
        {data.title === "" ? "（没有标题）" : data.title}
      </div>
    </div>
  );
}

const nodeTypes = { task: TaskNode };

export interface TaskGraphProps {
  tasks: TaskData[];
  statusOfTask: (taskId: string) => string;
  selected: string | null;
  onSelect: (taskId: string) => void;
}

export function TaskGraph({ tasks, statusOfTask, selected, onSelect }: TaskGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const layers = layoutLayers(tasks);
    const positions = new Map<string, { x: number; y: number }>();

    layers.forEach((layer, column) => {
      layer.forEach((task, row) => {
        positions.set(task.id, {
          x: column * (NODE_WIDTH + GAP_X),
          y: row * (NODE_HEIGHT + GAP_Y),
        });
      });
    });

    const nextNodes: Node<TaskNodeData>[] = tasks.flatMap((task) => {
      const position = positions.get(task.id);
      if (position === undefined) return [];
      return [
        {
          id: task.id,
          type: "task",
          position,
          data: {
            taskId: task.id,
            title: task.title ?? "",
            status: statusOfTask(task.id),
            selected: selected === task.id,
          },
        },
      ];
    });

    const nextEdges: Edge[] = tasks.flatMap((task) =>
      (task.depends_on ?? []).flatMap((dep) =>
        tasks.some((candidate) => candidate.id === dep)
          ? [{ id: `${dep}->${task.id}`, source: dep, target: task.id, type: "smoothstep" }]
          : [],
      ),
    );

    return { nodes: nextNodes, edges: nextEdges };
  }, [tasks, selected, statusOfTask]);

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-faint">
        还没有任务书。planner 交卷后,任务会一个一个出现在这里。
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      minZoom={0.3}
      proOptions={{ hideAttribution: false }}
    >
      <Background color="#eef2f7" gap={18} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
