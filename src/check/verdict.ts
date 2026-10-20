import type { LintFinding } from "../doc/lint.ts";
import type { ReportStatus } from "../doc/report.ts";
import type { ReplayOutcome } from "./replay.ts";
import type { CommandCheckOutcome } from "./run.ts";

/** 对一条 statement 级验收的语义判定 —— 这一项确实要靠模型读,不能只看退出码。 */
export interface StatementVerdict {
  statement: string;
  supported: boolean;
  detail: string;
}

export interface ReproducibleVerdict {
  passed: boolean;
  detail: string;
}

export interface VerdictInput {
  commandOutcomes: CommandCheckOutcome[];
  /** reproducible 级验收:把实验再做一遍的结果。 */
  reproducibleOutcomes: ReproducibleVerdict[];
  replayOutcomes: ReplayOutcome[];
  /** 已经按致命规则集筛过的 lint 结论。 */
  fatalLint: LintFinding[];
  statementVerdicts: StatementVerdict[];
  /** 报告里列出的未解决项。 */
  unresolved: string[];
  /** 任务书是否声明了 `no_unresolved` —— 声明了就不接受留尾巴。 */
  noUnresolvedRequired: boolean;
  /** worker 明确表示走不下去时的原因。 */
  blockedReason?: string;
}

export interface Verdict {
  status: ReportStatus;
  /** 判定依据,按「硬的先说」排列。会原样写进报告,前端直接显示。 */
  reasons: string[];
}

/**
 * 定状态。
 *
 * 这是纯函数、不含任何模型调用 —— 状态由机械判定落地,不由 worker 自报,
 * 也不由 verifier 的措辞决定。模型只能在 statement 级那一小块里发表意见。
 *
 * 硬伤(contradicted):验收没过、证据重放对不上、踩了致命 lint、陈述没被支撑、
 *   或任务书要求不留尾巴却留了。
 * 软伤(unverified):有证据**根本没法验**(比如引了 URL,内容随时间变)。
 *
 * 软伤不判失败,是为了抽掉说谎的动机 —— 一个不许说「我不知道」的系统,
 * 必然学会说「我做完了」。
 *
 * 反过来也要防:**不能把老实交代也当成软伤**。未解决项、输出漂移都只是披露,
 * 不改状态 —— 否则 agent 学到的是少说话,而这个项目要的正是它多说话。
 */
export function decideStatus(input: VerdictInput): Verdict {
  const hard: string[] = [];
  const soft: string[] = [];

  for (const outcome of input.commandOutcomes) {
    if (!outcome.passed) {
      hard.push(`验收未通过 \`${outcome.check.run}\`:${outcome.detail}`);
    }
  }

  // 复现失败是硬伤:这套输入和代码再做一遍得不出同一个结果,
  // 那这次实验的结论就没有可复现性可言
  for (const outcome of input.reproducibleOutcomes) {
    if (!outcome.passed) hard.push(`复现检查未通过:${outcome.detail}`);
  }

  for (const finding of input.fatalLint) {
    hard.push(`[${finding.rule}] ${finding.where}:${finding.detail}`);
  }

  for (const outcome of input.replayOutcomes) {
    if (outcome.verdict === "contradicted") {
      hard.push(`证据重放对不上:${outcome.detail}`);
      continue;
    }

    // 只有"根本没法验"才算没验全。drifted 不算:退出码重放上了,
    // 说明这条命令的结果确实如此,只是那份抄件不是逐字节可复现 ——
    // 那是抄件的性质,不是结论的可信度问题。它在判据列表里标注出来,
    // 但不把整个任务拉下来。
    //
    // 否则 `verified` 永远拿不到:`node --test` 每行都带耗时,
    // 靠测试验收的任务会全落到 unverified,这个状态也就不携带信息了。
    if (outcome.verdict === "unreplayable") {
      soft.push(outcome.detail);
    }
  }

  for (const verdict of input.statementVerdicts) {
    if (!verdict.supported) {
      hard.push(`陈述没有被报告支撑:「${verdict.statement}」—— ${verdict.detail}`);
    }
  }

  // 未解决项默认只是**披露**,不降级。
  //
  // 原先只要列了 unresolved 就判 unverified,结果是系统惩罚了它最想要的行为:
  // 一个跑了 14 条判据全过、却老实交代"我没法用哈希证明我没改测试文件"的 worker
  // 反而比什么都不说的拿得低。理性的 agent 学到的是少说话 —— 跟本项目的立意
  // 正好相反。
  //
  // 现在的界线:**验收就是"完成"的定义**。判据全过,任务就是完成了;报告里
  // 那些交代方法、划范围、承认能力边界的条目照样显示给人看,但不改状态。
  // 只有任务书明确要求 no_unresolved,留尾巴才算硬伤。
  for (const item of input.unresolved) {
    if (input.noUnresolvedRequired) hard.push(`未解决:${item}`);
  }

  if (input.blockedReason !== undefined && input.blockedReason !== "") {
    return {
      status: "blocked",
      reasons: [`走不下去:${input.blockedReason}`, ...hard, ...soft],
    };
  }

  if (hard.length > 0) {
    return { status: "contradicted", reasons: [...hard, ...soft] };
  }

  if (soft.length > 0) {
    return { status: "unverified", reasons: soft };
  }

  return { status: "verified", reasons: ["全部验收通过,且每条证据都重放成功。"] };
}
