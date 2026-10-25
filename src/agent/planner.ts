import type { Config } from "../config.ts";
import { validatePlan } from "../doc/plan.ts";
import { parseTaskDoc, type TaskDoc } from "../doc/task.ts";
import type { Usage } from "../llm.ts";
import { createLedger } from "../ledger.ts";
import type { SkillInfo } from "../skills.ts";
import { runToolLoop, type ChatFn, type LoopEvent } from "./loop.ts";
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

## 实验类任务必须带复现检查

如果任务的核心是「跑一个实验、得到一组数字」(准确率、时延、误差、吞吐、峰值内存……),
验收里**必须有 \`kind: reproducible\`** —— 把实验跑两遍,比对结果。

**只跑一遍、然后去 grep 日志里的数字,那不叫复现。** 那只证明"我读过这个文件",
证明不了这套输入和代码再做一遍还能得出同一个结果。

\`\`\`yaml
- kind: reproducible
  run: "python train.py --seed 42 --out {out}"
  runs: 2
  compare:
    - { path: "{out}/metrics.json", mode: numeric, tolerance: 1e-6 }
\`\`\`

- \`{out}\` 每遍会被换成各自的目录(repro-1、repro-2),所以两遍不会互相覆盖。
  **\`run\` 里必须有 \`{out}\`,否则会被拒。**
- \`mode: exact\` 逐字节比;\`mode: numeric\` 按数值比,允许相对容差(默认 1e-6)。
- 实验本来就不可能完全可复现时(GPU 非确定性、多线程归约)照样写这条 ——
  判成 unverified 本身就是有价值的结论,说明"这套实验只在多大程度上可复现"。

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
---

## 背景

## 交付要求

字段说明:
- \`id\` 形如 T-001,全局唯一。
- **每个字段都写在一行里**,尤其是 \`title\` 和 \`goal\`。YAML 遇到换行就解析不了,
  整份任务书会被打回。\`title\` 一句话就够(十几个字),要写的要求放进正文。
- **值里出现 \`{\` \`}\` \`#\` \`:\` 或引号时,整个值用双引号包起来。**
  这条最容易栽:YAML 看到 \`{\` 会当成 flow mapping 的开始,看到空格加 \`#\` 会当成注释。
  而带正则的验收命令太常见了 —— \`grep -qE '^#{1,3}'\` 这种不包引号必然解析失败。
  拿不准就包,包了不会有坏处。
- \`deliverable\` 必须是 \`reports/<id>.md\`。
- \`inputs\` 的 path 是相对工作目录的真实路径。
- \`acceptance\` 至少一条;command 级的 \`expect\` 至少写一项判据
  (exit_code / stdout_contains / stdout_matches / stdout_sha256)。
  一条判据都不写的验收会永远通过,比没有更糟,会被直接拒。
- \`structural\` 可用规则:evidence_for_every_claim、no_forbidden_words(这两条永远生效,
  写出来只是声明)、no_unresolved(要求不许留未解决项)、deliverable_matches_task。
- \`allow_terms\`:只有任务本身就在讲那些词时才写(比如「写一个 mock server」)。
  这是给误报留的唯一出口,别拿它当挡箭牌。

## 交卷

调用 submit_plan,\`tasks\` 是一个字符串数组,每项是一份完整任务文档。
格式或依赖有问题会被打回,照着错误改。`;

export interface PlanImage {
  /** 相对 run 目录,比如 `attachments/1.png`。 */
  path: string;
  dataUrl: string;
}

/** 已经在这棵树里的任务。追加模式下 planner 要看得到它们。 */
export interface ExistingTask {
  id: string;
  title: string;
  /** 裁定结果,或者"还没做"。 */
  status: string;
}

/**
 * 追加模式的附加规则。
 *
 * 核心一条:**只准加,不准改**。旧任务书写的是"当时我们决定这么验",
 * 事后改它就是篡改记录 —— 想改就新增一个任务去覆盖它,让两条决定都留着。
 * 这跟"事实只追加,视图去覆盖"是同一个原则。
 */
const APPEND_RULES = `

## 这次是**追加**,不是从零开始

这棵任务树里已经有任务了。你要做的是在它上面加,而不是重来:

- **只输出新增的任务。** 已经做完的不要再列一遍 —— 那等于改写它。
- 新任务的 \`id\` 不能和现有任何一个重复。
- 需要的话,\`depends_on\` 可以引用现有任务号。跨时间的依赖是允许的,而且往往是必要的 ——
  新任务改的很可能正是某个旧任务的产物,这条关系要写出来。
- **旧决定你觉得不对,不要改它。** 新增一个任务去覆盖它,并在正文里写明它取代了哪一条。
- 如果这次的要求其实不需要新任务(现状已经满足),就交一个空数组,并说明理由。

**别把仓库重读一遍。** 上面那份任务清单已经告诉你哪些做完了。
你需要的是"这次新增的要求涉及哪些文件",而不是把每个源文件读一遍 ——
把二十几个文件塞进上下文,既慢又贵,而且对你的判断没有帮助。
\`list_dir\` 看一眼结构,再按需读**这次真正相关的那几个**就够了。`;

export interface PlanOptions {
  config: Config;
  goal: string;
  workspace: string;
  /** 本次运行的目录。抓下来的数据和溯源链在这儿。 */
  runRoot: string;
  /** 用户随需求一起传上来的图。planner 看得见,才能把要求拆对。 */
  images?: PlanImage[];
  /** 现有任务树。给了就是**追加模式**:只输出新增任务。 */
  existing?: ExistingTask[];
  /** 已安装的技能。planner 只看到索引,正文留给 worker 去读。 */
  skills?: readonly SkillInfo[];
  timeoutMs: number;
  maxOutputChars: number;
  /** 只能看、不能改的工具 —— planner 摸现场用。 */
  discoveryTools: readonly Tool[];
  maxSteps: number;
  onEvent?: (event: LoopEvent) => void;
  /** 测试用:替换真实的模型调用。 */
  chat?: ChatFn;
}

export interface PlanResult {
  tasks: TaskDoc[];
  usage: Usage | null;
  /** 追加模式下 planner 认为不用新增任务。 */
  nothingToDo?: boolean;
  /** 没能产出合法任务树时的原因。 */
  failure?: string;
}

export async function plan(options: PlanOptions): Promise<PlanResult> {
  // 用对象装着:闭包里的赋值,TS 的控制流分析追不到,直接写变量会被收窄成 never
  const captured: { tasks: TaskDoc[] | null } = { tasks: null };

  // planner 只摸现场不动手,台账留着不用 —— 但工具签名要求它存在
  const toolContext: ToolContext = {
    workspace: options.workspace,
    runRoot: options.runRoot,
    ledger: createLedger(),
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  };

  const images = options.images ?? [];
  const existing = options.existing ?? [];
  const skills = options.skills ?? [];

  // 技能只在真有的时候才写进提示词 —— 没有技能时多说一句都是噪音
  const skillSection =
    skills.length === 0
      ? ""
      : `\n\n## 可用技能\n\n` +
        `这个仓库安装了下面这些工作手册。某个任务正好对口时,在它的任务书 frontmatter 里加一行:\n\n` +
        `\`skills: [名字]\`\n\n` +
        `worker 会拿到那份手册的全文和目录下的附件。**只写下面真实存在的名字** —— ` +
        `写错会被打回;拿不准就别写,技能不是必需品。\n\n` +
        skills.map((skill) => `- \`${skill.name}\` —— ${skill.description}`).join("\n");

  const lines = [`目标:\n\n${options.goal}`];

  if (existing.length > 0) {
    lines.push(
      `## 现有任务树(${existing.length} 个,不要重写它们)\n\n` +
        existing.map((task) => `- ${task.id}  ${task.title}  → ${task.status}`).join("\n"),
    );
  }

  if (images.length > 0) {
    lines.push(
      `## 附图(${images.length} 张)\n\n` +
        `路径相对本次运行的目录:\n` +
        images.map((image) => `- ${image.path}`).join("\n") +
        `\n\n需要用到图的那些任务,把对应用户写在任务书的 inputs 里:\n` +
        `  - { kind: image, path: "attachments/1.png" }\n` +
        `不写进去的话,worker 看不到这张图。`,
    );
  }

  const brief = lines.join("\n\n");

  // 有图时 user 消息变成内容块数组:一段文字 + 若干张图
  const user =
    images.length === 0
      ? brief
      : [
          { type: "text" as const, text: brief },
          ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } })),
        ];

  const result = await runToolLoop({
    config: options.config,
    system: (existing.length > 0 ? SYSTEM + APPEND_RULES : SYSTEM) + skillSection,
    user,
    tools: [...options.discoveryTools, PLAN_TOOL],
    toolContext,
    terminalTool: "submit_plan",
    maxSteps: options.maxSteps,
    agentName: "planner",
    onEvent: options.onEvent,
    ...(options.chat === undefined ? {} : { chat: options.chat }),

    onTerminal: (args) => {
      const raw = args.tasks;
      if (!Array.isArray(raw)) {
        return "`tasks` 必须是数组,每项是一份完整的任务文档字符串。";
      }

      // 空数组在**追加模式**下是合法结论("现状已经满足,不用加任务");
      // 全新规划时才是失败 —— 那说明目标根本没被拆开。
      if (raw.length === 0 && existing.length === 0) {
        return "`tasks` 不能为空 —— 目标没有被拆成任何可执行的东西。";
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

      // 追加模式下「现状已经满足、不用加任务」是合法结论,不是空手而归。
      // 全新规划时交空数组才是失败 —— 那说明目标根本没被拆开。
      const nothingToDo = existing.length > 0 && tasks.length === 0;

      // 技能名写错的话,worker 那边会找不到手册 —— 在这里就退回,别让它跑到一半才发现
      if (skills.length > 0) {
        const available = new Set(skills.map((skill) => skill.name));
        for (const task of tasks) {
          for (const name of task.skills) {
            if (!available.has(name)) {
              errors.push(
                `任务 ${task.id} 的 \`skills\` 里写了不存在的技能 \`${name}\`。` +
                  `可用的是:${skills.map((skill) => skill.name).join("、")}(不写也行)。`,
              );
            }
          }
        }
      }

      if (errors.length === 0 && !nothingToDo) {
        // 追加模式下,新任务的 depends_on 允许指向已有任务
        const planProblems = validatePlan(tasks, existing.map((task) => task.id));
        if (planProblems.length > 0) {
          return `任务树有问题:\n  - ${planProblems.join("\n  - ")}`;
        }
      }

      if (errors.length > 0) {
        return `有 ${errors.length} 处问题,改完再交:\n\n${errors.join("\n\n")}`;
      }

      captured.tasks = tasks;
      return undefined;
    },
  });

  const accepted = captured.tasks;
  if (accepted !== null) {
    return {
      tasks: accepted,
      usage: result.usage,
      ...(existing.length > 0 && accepted.length === 0 ? { nothingToDo: true } : {}),
    };
  }

  return {
    tasks: [],
    usage: result.usage,
    failure:
      result.status === "steps"
        ? `planner 用满 ${options.maxSteps} 步也没交出一份合格的任务树。`
        : "planner 没有交卷。",
  };
}
