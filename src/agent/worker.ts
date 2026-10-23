import { join } from "node:path";
import { loadImages } from "../attachments.ts";
import { addedOrChanged, signOutputs, snapshotDataFiles } from "../provenance.ts";
import type { Config } from "../config.ts";
import {
  parseReportDraft,
  type Claim,
  type Evidence,
  type ReportDoc,
  type ReportDraft,
} from "../doc/report.ts";
import { renderTaskDoc, type TaskDoc } from "../doc/task.ts";
import { createLedger, deriveFilesChanged, findCommand, findFile, renderLedger, type Ledger } from "../ledger.ts";
import type { Usage } from "../llm.ts";
import { loadSkill, renderSkill, skillFileTool, type Skill, type SkillInfo } from "../skills.ts";
import { runToolLoop, type ChatFn, type LoopEvent } from "./loop.ts";
import { workerTools, type Tool, type ToolContext } from "../tools/index.ts";

const REPORT_TOOL: Tool = {
  schema: {
    type: "function",
    function: {
      name: "submit_report",
      description:
        "交出交付报告。会立刻做格式校验,不合格会打回让你改。注意:证据只引用台账编号,不要写数字。",
      parameters: {
        type: "object",
        properties: {
          report: { type: "string", description: "完整的报告文档(frontmatter + 正文)。" },
        },
        required: ["report"],
      },
    },
  },
  async run() {
    throw new Error("submit_report 是终止工具,应当由循环拦下,不该走到这里。");
  },
};

const SYSTEM = `你是 mastic 的 worker。你拿到**一份**任务书,把它做完,然后交一份交付报告。

## 你会被怎么验

交卷之后,verifier 会:
1. **把你引用的每条命令重跑一遍**,比对退出码和 stdout 哈希;
2. 把任务书里的验收命令真跑一遍;
3. 机械扫描报告里的禁用词。

所以:**不要编。** 你没跑过的命令不要引用,你猜的结论不要写进 claims。
编出来的证据过不了重放 —— 退出码和哈希是你交卷那一刻台账里记下的真值,你改不了。

## 报告格式

---
task: T-001
claims:
  - statement: 一句话结论,具体、可对账
    evidence:
      - ref: C3
      - ref: F2
        note: "想补充说明就写这儿"
unresolved:
  - 没能验证的事
---

## 做了什么

## 未解决

## 铁律

0. **交付报告由 mastic 落盘,你不要自己去写 \`reports/*.md\`。**
   你要做的只有一件事:用 submit_report 交卷。自己写那份文件纯属白费功夫,
   而且会污染工作区。

1. **evidence 只写 \`ref\`,不写数字。** \`ref\` 是证据台账的编号:\`C1\` 是第 1 条命令,
   \`F1\` 是第 1 个文件。mastic 会拿台账里的真值把它展开。
   引用一个不存在的编号会被打回。

   **每个字段都写在一行里。** YAML 遇到换行就解析不了,整份报告会被打回 ——
   \`statement\` 想写长就写长,但别换行;要展开的内容放到正文里。

   \`note\` 是自由文本,写的时候**一定加双引号** —— 里面出现冒号或逗号会把 YAML 解析搞坏,
   然后整份报告会被打回。宁可写 \`note: "见 C3"\` 这种短的,也不要不加引号。
2. **每条 claim 至少要有一条证据。** 没有证据的结论不是"写得不好",是**不合法**。
   如果你确实证不了它,把它原样挪到 \`unresolved\`,别硬塞进 claims。
3. **你自己写的话里不许出现**:假设、假定、模拟、假装、猜测、大概是、应该是、理论上、
   占位、先这样、待补、assume、mock、simulate、placeholder、stub、dummy、fake。
   出现即被打回。想表达"这块我没底",请写进 \`unresolved\` —— 那是**合法**的,不会被罚。

   **引用不算。** 代码块里的命令原文、测试输出、文件正文不参与这项检查 ——
   贴 \`node --test\` 的输出不会被误伤。这条只筛你自己表态度的话。
4. **不要写 status。** 完没完成由 verifier 判,不由你自报。

   \`unresolved\` 的用法:写**任务要求了你却没做到**的事。交代方法、划清范围、
   承认能力边界这类说明,写进正文就行 —— 两种都不会让你掉分,但混在一起
   会让人看不出这个任务到底做完没有。
5. **确实做不下去时**,在 frontmatter 里写 \`blocked: <卡在哪,需要什么>\`。
   走不下去是合法结果;谎报做完了不是。

## 怎么攒证据

- 跑命令用 run_bash,它会给你一个 C 编号。
- 读/写文件用 read_file / write_file,给你 F 编号。
- **想拿它当证据,就得真跑、真写。** 台账里没有的,报告里也写不出来。

命令尽量选**确定性**的:退出码稳定、输出不带时间戳和耗时。
带时间戳的命令重放时会被判"输出漂移",你的 claim 就只能停在 unverified。

**更要紧的是别拿"会随你工作而变化"的命令当证据。** \`ls\`、\`find\`、\`git status\`、
目录树这类命令,输出会因为你随后写了文件而改变 —— 等 verifier 重放时它已经是
另一个结果了,那条证据直接作废。想要"我建了这个文件"的证据,
用 \`read_file\` 拿到的 F 编号(它记的是文件内容的哈希),而不是列目录。

先读任务书里的 \`acceptance\` —— 那是你被验的判据。**照着它干活**,别做完才发现条件不对。

## 关于步数

你有步数上限(由这次运行的剩余预算分配而来)。**别把步数全花在调查上** ——
读几个关键文件就该动手,边做边跑测试。步数用尽时你会被要求立刻交卷,
那时候只能交一份不完整的报告。宁可早点交一份诚实的,也不要查到最后交不出东西。`;

export interface WorkOptions {
  config: Config;
  task: TaskDoc;
  workspace: string;
  /** 本次运行的目录。任务书里的图片路径相对它 —— 图片不在工作区里。 */
  runRoot: string;
  timeoutMs: number;
  maxOutputChars: number;
  /** 这轮最多几步。由调用方按剩余预算分配,不由任务书决定。 */
  maxSteps: number;
  /** 上一轮 verifier 的结论。重试时才有。 */
  findings?: string[];
  /** MCP 服务提供的工具。它们的结果不进证据台账。 */
  mcpTools?: readonly Tool[];
  /** 技能索引。任务书里写了的名字会被解析成手册正文。 */
  skills?: readonly SkillInfo[];
  onEvent?: (event: LoopEvent) => void;
  /** 测试用:替换真实的模型调用,好在不烧 token 的前提下看清发了什么。 */
  chat?: ChatFn;
}

export interface WorkResult {
  report?: ReportDoc;
  /** 动手前工作区里已有的数据文件(相对路径)。那些是用户的,不要求证明来源。 */
  preexistingData: string[];
  draft?: ReportDraft;
  ledger: Ledger;
  usage: Usage | null;
  failure?: string;
  /** 这一轮实际用掉几步。运行级预算按实际扣,不按上限扣。 */
  steps: number;
}

/**
 * 把草稿里的台账编号换成真值。
 *
 * 这一步是"worker 没有可编造的字段"的兑现处:草稿里只有 C3 / F2 这样的引用,
 * 退出码、哈希、路径统统从台账取。引用不存在的编号直接打回。
 */
function resolveDraft(draft: ReportDraft, ledger: Ledger): { report?: ReportDoc; errors: string[] } {
  const errors: string[] = [];
  const claims: Claim[] = [];

  draft.claims.forEach((claim, index) => {
    const evidence: Evidence[] = [];

    for (const item of claim.evidence) {
      if (item.ref.startsWith("C")) {
        const record = findCommand(ledger, item.ref);
        if (record === undefined) {
          errors.push(`claims[${index}] 引用了 \`${item.ref}\`,但台账里没有这条命令。`);
          continue;
        }
        evidence.push({
          kind: "command",
          run: record.run,
          cwd: record.cwd,
          exit_code: record.exitCode,
          stdout_sha256: record.stdoutSha256,
          stdout_bytes: record.stdoutBytes,
          ...(item.note === undefined ? {} : { note: item.note }),
        });
        continue;
      }

      const record = findFile(ledger, item.ref);
      if (record === undefined) {
        errors.push(`claims[${index}] 引用了 \`${item.ref}\`,但台账里没有这个文件。`);
        continue;
      }
      evidence.push({
        kind: "file",
        path: record.path,
        sha256: record.sha256,
        ...(item.note === undefined ? {} : { note: item.note }),
      });
    }

    if (evidence.length > 0) claims.push({ statement: claim.statement, evidence });
  });

  if (errors.length > 0) return { errors };

  return {
    errors: [],
    report: {
      task: draft.task,
      // 占位值。真正的裁定由 verifier 写 —— worker 自报的 status 一律不看。
      status: "unverified",
      claims,
      files_changed: deriveFilesChanged(ledger),
      unresolved: draft.unresolved,
      ...(draft.blocked === undefined ? {} : { blocked_reason: draft.blocked }),
      body: draft.body,
    },
  };
}

export async function work(options: WorkOptions): Promise<WorkResult> {
  const ledger = createLedger();
  // 动手之前先拍一张,结束时再拍一张 —— 差集就是这次产出的数据
  const before = await snapshotDataFiles(options.workspace);
  const toolContext: ToolContext = {
    workspace: options.workspace,
    runRoot: options.runRoot,
    ledger,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  };

  let resolved: ReportDoc | null = null;
  let accepted: ReportDraft | null = null;

  const retryNote =
    options.findings === undefined || options.findings.length === 0
      ? ""
      : `\n\n## 上一轮为什么没通过\n\n${options.findings.map((line) => `- ${line}`).join("\n")}\n\n` +
        "带着这些去改。别重复上一轮的做法。";

  // 任务书里声明为 image 的输入,在这里变成真正发给模型的图。
  // 不声明的就不发 —— 图片很贵,不该无条件塞给每个 worker。
  const imagePaths = options.task.inputs.flatMap((input) =>
    input.kind === "image" && input.path !== undefined ? [input.path] : [],
  );
  const images = imagePaths.length === 0 ? [] : await loadImages(options.runRoot, imagePaths);

  // 任务书里点名的技能,在这里读成正文。找不到的不算致命 ——
  // 技能是做法上的辅助,缺了手册活还是能干的(要不要停由 worker 自己判断)。
  const assigned: Skill[] = [];
  const missingSkills: string[] = [];
  for (const name of options.task.skills) {
    const info = (options.skills ?? []).find((skill) => skill.name === name);
    const loaded = info === undefined ? null : await loadSkill(info);
    if (loaded === null) missingSkills.push(name);
    else assigned.push(loaded);
  }

  const skillBrief =
    assigned.length === 0 ? "" : `\n\n## 技能\n\n${assigned.map(renderSkill).join("\n\n")}`;

  const missingBrief =
    missingSkills.length === 0
      ? ""
      : `\n\n## 技能缺失\n\n任务书要求了 ${missingSkills.join("、")},但没能加载。` +
        `缺手册不影响你动手;如果缺了它这活根本没法做,写 blocked 说明。`;

  // MCP 的结果没法重放,所以不能当证据 —— 这条边界要在它拿到工具的同时说清楚,
  // 否则它会把一次外部查询当成"我验证过了"。
  const mcpBrief =
    (options.mcpTools?.length ?? 0) === 0
      ? ""
      : `\n\n## 外部工具\n\n` +
        `\`mcp__*\` 是外部 MCP 服务提供的工具。它们能帮你查东西、做事,` +
        `但它们的结果**不进证据台账**,不能当证据引用 —— 外部服务的返回重放不了。` +
        `要拿它们的结果下结论,请留下一条可重跑的命令或一份可核对的文件作为证据。`;

  const brief =
    `## 任务书\n\n${renderTaskDoc(options.task)}${retryNote}` +
    skillBrief +
    missingBrief +
    mcpBrief +
    (images.length === 0
      ? ""
      : `\n\n## 附图\n\n任务书里的 ${imagePaths.length} 张图已经附在这条消息上,直接看。`) +
    `\n\n## 现在开始干活\n\n先读 acceptance 那条,再动手。`;

  const result = await runToolLoop({
    config: options.config,
    system: SYSTEM,
    user: images.length === 0 ? brief : [{ type: "text" as const, text: brief }, ...images],
    tools: [
      ...workerTools,
      ...(assigned.length === 0 ? [] : [skillFileTool(assigned)]),
      ...(options.mcpTools ?? []),
      REPORT_TOOL,
    ],
    toolContext,
    terminalTool: "submit_report",
    maxSteps: options.maxSteps,
    onEvent: options.onEvent,
    ...(options.chat === undefined ? {} : { chat: options.chat }),

    onTerminal: (args) => {
      const raw = args.report;
      if (typeof raw !== "string") {
        return "`report` 必须是完整的报告文档字符串。";
      }

      const { draft, errors } = parseReportDraft(raw);
      if (draft === undefined) {
        return `报告格式有问题,改完再交:\n\n  - ${errors.join("\n  - ")}`;
      }

      const { report, errors: resolveErrors } = resolveDraft(draft, ledger);
      if (report === undefined) {
        return (
          `报告里有引用对不上台账,改完再交:\n\n  - ${resolveErrors.join("\n  - ")}\n\n` +
          `当前台账:\n${renderLedger(ledger)}`
        );
      }

      resolved = report;
      accepted = draft;
      return undefined;
    },
  });

  if (resolved !== null && accepted !== null) {
    // 给这次**产出的数据**签字。
    //
    // 放在 work 里而不是调用方,因为调用方有两处(orchestrate 和 resume)——
    // 同一件事写在两个地方,迟早会漏掉一个。这个教训今天已经吃过三次了。
    //
    // 产出靠前后快照的差集认,不靠 worker 声明:声明是它最可能忘、也最不该忘的事。
    const produced = addedOrChanged(before, await snapshotDataFiles(options.workspace));
    if (produced.length > 0) {
      await signOutputs(
        join(options.runRoot, "provenance.jsonl"),
        options.task.id,
        produced,
        ledger.commands.map((command) => command.id),
      );
    }

    return {
      report: resolved,
      draft: accepted,
      ledger,
      usage: result.usage,
      steps: result.steps,
      preexistingData: [...before.keys()],
    };
  }

  return {
    ledger,
    preexistingData: [...before.keys()],
    usage: result.usage,
    steps: result.steps,
    failure:
      result.status === "steps"
        ? `worker 用满 ${options.maxSteps} 步也没交出一份合格的报告。`
        : "worker 没有交卷。",
  };
}
