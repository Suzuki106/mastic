import { replayEvidence } from "../check/replay.ts";
import { runCommandChecks } from "../check/run.ts";
import { decideStatus, type StatementVerdict, type Verdict } from "../check/verdict.ts";
import type { Config } from "../config.ts";
import { fatalFindings, lintReport } from "../doc/lint.ts";
import type { CheckReport, ReportDoc } from "../doc/report.ts";
import type { StatementCheck, TaskDoc } from "../doc/task.ts";
import { streamChat, type Usage } from "../llm.ts";

export interface VerifyOptions {
  config: Config;
  task: TaskDoc;
  report: ReportDoc;
  workspace: string;
  timeoutMs: number;
  onEvent?: (detail: string) => void;
}

export interface VerifyResult {
  verdict: Verdict;
  /** 带上 status 与 verdict 的报告 —— 这份才是最终落盘的。 */
  report: ReportDoc;
  /** 只有跑过陈述判定时才有值,纯机械判定不烧 token。 */
  usage: Usage | null;
}

function statementChecks(task: TaskDoc): StatementCheck[] {
  return task.acceptance.filter((check): check is StatementCheck => check.kind === "statement");
}

/** 从模型回复里挖出 JSON —— 它经常裹一层 ``` 或者加两句开场白。 */
function extractJsonArray(reply: string): unknown[] | null {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const JUDGE_SYSTEM = `你是 mastic 的 verifier,只做一件事:判断报告里的主张,是否真的支撑了任务书里的某条陈述。

给你的是一份报告已经写出来的 claims(每条都带着可重放证据,证据本身已经过了机械校验)。
你要回答的不是"证据是真的吗" —— 那部分已经验完了。你要回答的是:
**这些主张加在一起,能不能支撑那条陈述?**

判定要严。陈述说"所有 X 都做了",报告只提了其中一个,就是不支撑。
陈述说"没有引入新依赖",报告压根没提依赖,也是不支撑。

只输出 JSON 数组,不要开场白,不要解释:
[{"statement": "原样的陈述", "supported": true, "detail": "一句话说依据"}]`;

/**
 * statement 级验收的语义判定。
 *
 * 这是整个 verifier 里**唯一**用到模型的地方 —— 其余全是机械判定。
 * 没有 statement 级检查时一步 API 都不调。
 */
async function judgeStatements(
  options: VerifyOptions,
  checks: StatementCheck[],
): Promise<{ verdicts: StatementVerdict[]; usage: Usage | null }> {
  if (checks.length === 0) return { verdicts: [], usage: null };

  const claims = options.report.claims
    .map((claim, index) => {
      const evidence = claim.evidence
        .map((item) => {
          if (item.kind === "command") return `命令 \`${item.run}\` → 退出码 ${item.exit_code}`;
          if (item.kind === "file") return `文件 \`${item.path}\` (${item.sha256.slice(0, 12)}…)`;
          return `URL \`${item.url}\``;
        })
        .join(";");
      return `${index + 1}. ${claim.statement}\n   证据:${evidence}`;
    })
    .join("\n");

  const unresolved =
    options.report.unresolved.length === 0
      ? "(无)"
      : options.report.unresolved.map((item) => `- ${item}`).join("\n");

  const { reply, usage } = await streamChat(options.config, [
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content:
        `待判定的陈述:\n${checks.map((check, index) => `${index + 1}. ${check.statement}`).join("\n")}\n\n` +
        `报告的主张:\n${claims}\n\n报告的未解决项:\n${unresolved}\n\n` +
        `报告正文:\n${options.report.body}`,
    },
  ]);

  const parsed = extractJsonArray(reply);

  // 解析不出来时**从严**:判为不支撑。verifier 宁可拦住,不可放过。
  if (parsed === null) {
    options.onEvent?.("verifier 的陈述判定没能解析成 JSON,按不支撑处理");
    return {
      usage,
      verdicts: checks.map((check) => ({
        statement: check.statement,
        supported: false,
        detail: "verifier 没能给出可解析的判定,从严判为不支撑。",
      })),
    };
  }

  const verdicts = checks.map((check, index) => {
    const item = parsed[index];
    if (typeof item !== "object" || item === null) {
      return { statement: check.statement, supported: false, detail: "verifier 漏判了这条陈述。" };
    }

    const record = item as Record<string, unknown>;
    return {
      statement: check.statement,
      supported: record.supported === true,
      detail: typeof record.detail === "string" ? record.detail : "",
    };
  });

  return { verdicts, usage };
}

/**
 * 验一份报告,给出裁定。
 *
 * 顺序是刻意的:机械判定先跑,跑完才轮到模型 —— 而且只在有 statement 级
 * 验收时才轮到它。绝大多数任务的裁定完全不经过模型。
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const { task, report, workspace, timeoutMs } = options;

  options.onEvent?.(`跑 ${task.acceptance.filter((c) => c.kind === "command").length} 条验收命令`);
  const commandOutcomes = await runCommandChecks(task, {
    workspace,
    timeoutMs,
    onRun: (command, result) => options.onEvent?.(`  ${command} → 退出码 ${result.exitCode}`),
  });

  options.onEvent?.(`重放 ${report.claims.reduce((sum, c) => sum + c.evidence.length, 0)} 条证据`);
  const replayOutcomes = await replayEvidence(report, { workspace, timeoutMs });

  const findings = lintReport(report, task);
  const fatalLint = fatalFindings(findings, task);

  const checks = statementChecks(task);
  if (checks.length > 0) options.onEvent?.(`判定 ${checks.length} 条陈述级验收`);
  const { verdicts: statementVerdicts, usage } = await judgeStatements(options, checks);

  const verdict = decideStatus({
    commandOutcomes,
    replayOutcomes,
    fatalLint,
    statementVerdicts,
    unresolved: report.unresolved,
    noUnresolvedRequired: task.acceptance.some(
      (check) => check.kind === "structural" && check.require.includes("no_unresolved"),
    ),
    ...(report.blocked_reason === undefined ? {} : { blockedReason: report.blocked_reason }),
  });

  const checkReports: CheckReport[] = [
    ...commandOutcomes.map((outcome) => ({
      kind: "command" as const,
      label: outcome.check.label ?? outcome.check.run,
      passed: outcome.passed,
      detail: outcome.detail,
    })),
    ...replayOutcomes.map((outcome) => {
      const evidence = report.claims[outcome.claimIndex]?.evidence[outcome.evidenceIndex];
      const label =
        evidence === undefined
          ? `证据 #${outcome.claimIndex + 1}.${outcome.evidenceIndex + 1}`
          : evidence.kind === "command"
            ? `证据 \`${evidence.run}\``
            : evidence.kind === "file"
              ? `证据 \`${evidence.path}\``
              : `证据 \`${evidence.url}\``;
      // drifted 记为"过,但附一句" —— 退出码重放上了,结论站得住,
      // 只是那份抄件不逐字节可复现。它不该被画成 ✗,那会像是没验过。
      return {
        kind: "evidence" as const,
        label,
        passed: outcome.verdict === "replayed" || outcome.verdict === "drifted",
        detail: outcome.detail,
        ...(outcome.verdict === "drifted" ? { caveat: true } : {}),
      };
    }),
    ...statementVerdicts.map((item) => ({
      kind: "statement" as const,
      label: item.statement,
      passed: item.supported,
      detail: item.detail,
    })),
    ...fatalLint.map((finding) => ({
      kind: "lint" as const,
      label: `${finding.rule} @ ${finding.where}`,
      passed: false,
      detail: finding.detail,
    })),
  ];

  return {
    verdict,
    usage,
    report: {
      ...report,
      status: verdict.status,
      verdict: {
        decided_at: new Date().toISOString(),
        reasons: verdict.reasons,
        checks: checkReports,
      },
    },
  };
}
