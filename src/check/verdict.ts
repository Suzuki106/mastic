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

export interface VerdictInput {
  commandOutcomes: CommandCheckOutcome[];
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
 * 硬伤(contradicted):验收没过、证据重放对不上、踩了致命 lint、陈述没被支撑。
 * 软伤(unverified):输出不可逐字节复现、URL 证据不可重放、有明确未解决项。
 *
 * 软伤不判失败,是为了抽掉说谎的动机 —— 一个不许说「我不知道」的系统,
 * 必然学会说「我做完了」。
 */
export function decideStatus(input: VerdictInput): Verdict {
  const hard: string[] = [];
  const soft: string[] = [];

  for (const outcome of input.commandOutcomes) {
    if (!outcome.passed) {
      hard.push(`验收未通过 \`${outcome.check.run}\`:${outcome.detail}`);
    }
  }

  for (const finding of input.fatalLint) {
    hard.push(`[${finding.rule}] ${finding.where}:${finding.detail}`);
  }

  for (const outcome of input.replayOutcomes) {
    if (outcome.verdict === "contradicted") {
      hard.push(`证据重放对不上:${outcome.detail}`);
    } else if (outcome.verdict === "drifted" || outcome.verdict === "unreplayable") {
      soft.push(outcome.detail);
    }
  }

  for (const verdict of input.statementVerdicts) {
    if (!verdict.supported) {
      hard.push(`陈述没有被报告支撑:「${verdict.statement}」—— ${verdict.detail}`);
    }
  }

  // 有未解决项:任务书要求不留尾巴就算硬伤,没要求就只是"没验全",降到 unverified
  for (const item of input.unresolved) {
    const line = `未解决:${item}`;
    if (input.noUnresolvedRequired) hard.push(line);
    else soft.push(line);
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
