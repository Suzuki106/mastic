import { join } from "node:path";
import { replayEvidence } from "../check/replay.ts";
import { runReproducibleChecks } from "../check/reproduce.ts";
import { runCommandChecks } from "../check/run.ts";
import { decideStatus, type StatementVerdict, type Verdict } from "../check/verdict.ts";
import type { Config } from "../config.ts";
import type { LintFinding } from "../doc/lint.ts";
import { fatalFindings, lintReport } from "../doc/lint.ts";
import type { CheckReport, ReportDoc } from "../doc/report.ts";
import type { StatementCheck, TaskDoc } from "../doc/task.ts";
import type { Ledger } from "../ledger.ts";
import { streamChat, type Usage } from "../llm.ts";
import { resolveInside } from "../paths.ts";
import { sha256File } from "../exec.ts";
import { DATA_DIR, listFiles, looksLikeDataFile, readProvenance, traceInput } from "../provenance.ts";

export interface VerifyOptions {
  config: Config;
  task: TaskDoc;
  report: ReportDoc;
  workspace: string;
  /** 本次运行的目录。溯源链在这儿。 */
  runRoot: string;
  /** worker 这一轮读写了什么。数据输入的溯源检查靠它。 */
  ledger: Ledger;
  /** 动手前工作区里已有的数据文件 —— 那些算用户提供的。 */
  preexistingData: string[];
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
  const reproducibleOutcomes = await runReproducibleChecks(task, {
    workspace,
    timeoutMs,
    onRun: (command, index, result) =>
      options.onEvent?.(`  第 ${index} 遍 ${command} → 退出码 ${result.exitCode}`),
  });
  const replayOutcomes = await replayEvidence(report, { workspace, timeoutMs });

  const findings = [
    ...lintReport(report, task),
    ...(await checkDataInputs(options)),
    ...(await checkDataDir(options)),
    ...(await checkSignedArtifacts(options)),
  ];
  const fatalLint = fatalFindings(findings, task);

  const checks = statementChecks(task);
  if (checks.length > 0) options.onEvent?.(`判定 ${checks.length} 条陈述级验收`);
  const { verdicts: statementVerdicts, usage } = await judgeStatements(options, checks);

  const verdict = decideStatus({
    commandOutcomes,
    reproducibleOutcomes,
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
    ...reproducibleOutcomes.map((outcome) => ({
      kind: "reproducible" as const,
      label: outcome.check.label ?? outcome.check.run,
      passed: outcome.passed,
      detail: outcome.detail,
    })),
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

/**
 * 实验输入必须可溯源。
 *
 * 这是整个数据自证方向的落点:一份数据文件被当输入用了,它就必须能沿溯源链
 * 走回**外部抓取**或**用户提供**。走不回去的,是模型自己写出来的东西 ——
 * 拿它跑实验等于什么都没测。
 *
 * 动手前工作区里本来就有的数据不算在内:那是用户放进仓库的,来源是用户。
 * 只有**这一轮运行期间新出现**的数据文件才需要证明来路。
 */
async function checkDataInputs(options: VerifyOptions): Promise<LintFinding[]> {
  const provenancePath = join(options.runRoot, "provenance.jsonl");
  const preexisting = new Set(options.preexistingData);

  const read = new Set(
    options.ledger.files
      .filter((file) => file.action === "read" && looksLikeDataFile(file.path))
      .map((file) => file.path),
  );

  const findings: LintFinding[] = [];

  for (const path of read) {
    if (preexisting.has(path)) continue;

    let verdict;
    try {
      verdict = await traceInput(provenancePath, resolveInside(options.workspace, path));
    } catch {
      continue; // 路径越界之类,不在这里报
    }

    if (verdict.traceable) continue;

    findings.push({ rule: "experiment_inputs_traceable", where: path, detail: verdict.detail });
  }

  return findings;
}

/**
 * 原始数据区只读。
 *
 * `data/` 按定义只装两种东西:**抓来的**和**用户给的** —— 两者都在溯源链上。
 * 所以出现一个不在链上的文件,就说明有人往原始数据区里塞了东西,而那些东西
 * 没有来源。这是"伪造观测"最直接的形式。
 *
 * 这条判据不需要前后快照:目录的**内容**本身就说明了问题。
 *
 * 注意它拦不住 `run_bash` 往里写 —— 同用户的进程想写就能写。它能做的是
 * **事后发现**:写进去的东西没来源,任务就判不过。
 */
async function checkDataDir(options: VerifyOptions): Promise<LintFinding[]> {
  const dataDir = join(options.workspace, DATA_DIR);
  const provenancePath = join(options.runRoot, "provenance.jsonl");
  const findings: LintFinding[] = [];

  for (const relative of await listFiles(dataDir)) {
    const verdict = await traceInput(provenancePath, join(dataDir, relative));
    if (verdict.traceable) continue;

    findings.push({
      rule: "data_dir_untouched",
      where: `${DATA_DIR}/${relative}`,
      detail: `原始数据区里出现了没有来源的文件。${verdict.detail}`,
    });
  }

  return findings;
}

/**
 * 签过字的产出,现在还是不是那个哈希。
 *
 * 证据重放只能证明"这条命令对现在磁盘上那份文件是可复现的"。它**没有原件
 * 可以参照** —— 如果文件在记录之前就被改了,重放每次都"一致",因为基准本身
 * 就是改过的。
 *
 * 签名补的就是这个参照:产出那一刻的哈希进了链。所以验证时把它重算一遍,
 * 对不上就说明这份数据在签字之后被动过,之后所有引用它的证据都不作数。
 *
 * 边界仍在:签名记录的是"任务结束时是什么",不是"命令产出了什么"。任务进行
 * 期间、命令产出与签字之间的修改,这里查不出来。
 */
async function checkSignedArtifacts(options: VerifyOptions): Promise<LintFinding[]> {
  const chain = await readProvenance(join(options.runRoot, "provenance.jsonl"));
  const findings: LintFinding[] = [];

  for (const entry of chain) {
    if (entry.kind !== "derived" || entry.path === undefined || entry.sha256 === undefined) continue;

    let actual: string;
    try {
      actual = await sha256File(resolveInside(options.workspace, entry.path));
    } catch {
      findings.push({
        rule: "signed_artifacts_unchanged",
        where: entry.path,
        detail: `签过字的产出不见了(签名 #${entry.seq})。`,
      });
      continue;
    }

    if (actual !== entry.sha256) {
      findings.push({
        rule: "signed_artifacts_unchanged",
        where: entry.path,
        detail:
          `产出后被动过:签名 #${entry.seq} 记的是 ${entry.sha256.slice(0, 12)}…,` +
          `现在是 ${actual.slice(0, 12)}… —— 引用它的证据都不作数了。`,
      });
    }
  }

  return findings;
}
