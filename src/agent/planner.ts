import type { Config } from "../config.ts";
import { validatePlan } from "../doc/plan.ts";
import { parseTaskDoc, type TaskDoc } from "../doc/task.ts";
import type { Usage } from "../llm.ts";
import { createLedger } from "../ledger.ts";
import { runToolLoop, type LoopEvent } from "./loop.ts";
import type { Tool, ToolContext } from "../tools/index.ts";

/** 终止工具只用来"接住"交卷动作 —— 循环会在派发前拦下它,run 永远不会被调到。 */
function terminalTool(name: string, description: string, parameters: unknown): Tool {
  return {
    schema: { type: "function", function: { name, description, parameters } },
    async run() {
      throw new Error(`${name} 是终止工具,应当由循环拦下,不该走到这里。`);
    },
  };
}

const PLAN_TOOL = terminalTool(
  "submit_plan",
  "把拆好的任务树交给 mastic。交上来会立刻做格式与依赖校验,不通过会打回让你改。",
  {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "每项是一份完整的任务文档(frontmatter + 正文)。",
        items: { type: "string" },
      },
    },
    required: ["tasks"],
  },
);

const SYSTEM = `你是 mastic 的 planner。

用户给一个目标,你负责把它拆成一棵**任务树**。每个任务是一份完整的 Markdown 文档 ——
它会原样落盘、给人看、给 worker 照着干活、给前端解析。所以它得同时是「能被执行的要求」
和「人能读懂的交接说明」。

**先摸现场再动手。** 用 list_dir / read_file 看清仓库结构。不要凭印象拆 ——
你没读过的文件不该出现在 inputs 里。

**别浪费步数**:跳过 \`node_modules/\` 和 \`.mastic/\`(那是 mastic 自己的运行产物)。
读源码读测试读配置就够,不要逐个文件翻依赖。

## 拆任务的原则

1. 每个任务都要能被独立验证。拆不出验收标准的任务,说明还没拆够细。
2. 能跑的都写成 command 级。有测试就写测试命令,有构建就写构建命令。
3. 不要为了凑数拆。一个任务能做完的事不要拆成三个。
4. 依赖只写真正的前置。把「先后无所谓」写成依赖,会让本可并行的活儿串起来。

## 指标分三级,按顺序下沉

- \`command\`:能跑的都归这级。真跑,看退出码 / stdout。
- \`structural\`:产物不可执行时(散文、方案、文档)。
- \`statement\`:前两级都不适用时,退到「一条可证伪的陈述」。

**不要用 statement 逃避。** 能用 command 就必须用 command。

## 任务文档格式

---
id: T-001
title: 一句话说清干什么
goal: 这个任务要达成什么。worker 读完就该知道做什么。
depends_on: []
inputs:
  - { kind: file, path: src/foo.ts }
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "npm test -- foo", expect: { exit_code: 0 } }
  - { kind: structural, require: [evidence_for_every_claim, no_forbidden_words] }
constraints:
  - 不要改 public API
budget: { max_steps: 24 }
---

## 背景

## 交付要求

字段说明:
- \`id\` 形如 T-001,全局唯一。
- \`deliverable\` 必须是 \`reports/<id>.md\`。
- \`inputs\` 的 path 是相对工作目录的真实路径。
- \`acceptance\` 至少一条;command 级的 \`expect\` 至少写一项判据
  (exit_code / stdout_contains / stdout_matches / stdout_sha256)。
  一条判据都不写的验收会永远通过,比没有更糟,会被直接拒。
- \`structural\` 可用规则:evidence_for_every_claim、no_forbidden_words(这两条永远生效,
  写出来只是声明)、no_unresolved(要求不许留未解决项)、deliverable_matches_task。
- \`allow_terms\`:只有任务本身就在讲那些词时才写(比如「写一个 mock server」)。
  这是给误报留的唯一出口,别拿它当挡箭牌。
- \`budget.max_steps\` 是 worker 的工具往返上限,**宁可给宽一点**:
  在真实仓库里光是把相关文件读明白就可能花掉十几步,给窄了任务会在
  做到一半时被截断。改动一个文件给 30,涉及多文件或要反复跑测试给 60。

## 交卷

调用 submit_plan,\`tasks\` 是一个字符串数组,每项是一份完整任务文档。
格式或依赖有问题会被打回,照着错误改。`;

export interface PlanOptions {
  config: Config;
  goal: string;
  workspace: string;
  timeoutMs: number;
  maxOutputChars: number;
  /** 只能看、不能改的工具 —— planner 摸现场用。 */
  discoveryTools: readonly Tool[];
  maxSteps: number;
  onEvent?: (event: LoopEvent) => void;
}

export interface PlanResult {
  tasks: TaskDoc[];
  usage: Usage | null;
  /** 没能产出合法任务树时的原因。 */
  failure?: string;
}

export async function plan(options: PlanOptions): Promise<PlanResult> {
  let submitted: TaskDoc[] | null = null;

  // planner 只摸现场不动手,台账留着不用 —— 但工具签名要求它存在
  const toolContext: ToolContext = {
    workspace: options.workspace,
    ledger: createLedger(),
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  };

  const result = await runToolLoop({
    config: options.config,
    system: SYSTEM,
    user: `目标:\n\n${options.goal}`,
    tools: [...options.discoveryTools, PLAN_TOOL],
    toolContext,
    terminalTool: "submit_plan",
    maxSteps: options.maxSteps,
    onEvent: options.onEvent,

    onTerminal: (args) => {
      const raw = args.tasks;
      if (!Array.isArray(raw) || raw.length === 0) {
        return "`tasks` 必须是非空数组,每项是一份完整的任务文档字符串。";
      }

      const errors: string[] = [];
      const tasks: TaskDoc[] = [];

      raw.forEach((item, index) => {
        if (typeof item !== "string") {
          errors.push(`tasks[${index}] 不是字符串。`);
          return;
        }
        const { task, errors: itemErrors } = parseTaskDoc(item);
        if (task === undefined) {
          errors.push(`tasks[${index}] 不合格:\n  - ${itemErrors.join("\n  - ")}`);
          return;
        }
        tasks.push(task);
      });

      if (errors.length === 0) {
        const planProblems = validatePlan(tasks);
        if (planProblems.length > 0) {
          return `任务树有问题:\n  - ${planProblems.join("\n  - ")}`;
        }
      }

      if (errors.length > 0) {
        return `有 ${errors.length} 处问题,改完再交:\n\n${errors.join("\n\n")}`;
      }

      submitted = tasks;
      return undefined;
    },
  });

  if (submitted !== null) return { tasks: submitted, usage: result.usage };

  return {
    tasks: [],
    usage: result.usage,
    failure:
      result.status === "steps"
        ? `planner 用满 ${options.maxSteps} 步也没交出一份合格的任务树。`
        : "planner 没有交卷。",
  };
}
