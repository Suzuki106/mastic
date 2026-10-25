import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replayEvidence } from "../check/replay.ts";
import { decideStatus } from "../check/verdict.ts";
import { fatalFindings, lintReport } from "../doc/lint.ts";
import { parseReportDoc, type Evidence, type ReportDoc } from "../doc/report.ts";
import { readProvenance, traceInput, verifyChain } from "../provenance.ts";

/**
 * `mastic evidence` —— 给不跑 mastic agent 的使用者留的入口。
 *
 * 输入只有两样:一份按格式写的报告,和一个工作区。不需要 API key,
 * 不调模型,不起外部进程。CI 里可以直接跑。
 */

export interface EvidenceCliOptions {
  workspace: string;
  json: boolean;
}

const USAGE = `mastic evidence —— 不改代码,只判证据

用法:
  mastic evidence verify <report.md>        重放报告里每条证据,给出裁定
  mastic evidence chain <provenance.jsonl>  校验溯源链有没有断
  mastic evidence trace <provenance.jsonl> <file>
                                            查一个数据文件的来源

可选项:
  --workspace <路径>   证据里的相对路径相对谁(默认当前目录)
  --json               输出机器可读的 JSON
`;

function labelOf(evidence: Evidence): string {
  if (evidence.kind === "command") return evidence.run;
  if (evidence.kind === "file") return evidence.path;
  return evidence.url;
}

interface VerifyJson {
  command: "verify";
  task: string;
  status: string;
  reasons: string[];
  evidence: { label: string; verdict: string; detail: string }[];
}

async function verifyReport(
  path: string,
  options: EvidenceCliOptions,
): Promise<{ code: number; json: VerifyJson | null; human: string[] }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { code: 1, json: null, human: [`读不到 ${path}:${detail}`] };
  }

  const { report, errors } = parseReportDoc(raw);
  if (report === undefined) {
    return { code: 1, json: null, human: [`${path} 不是合格的报告:`, ...errors.map((e) => `  - ${e}`)] };
  }

  const replayOutcomes = await replayEvidence(report, {
    workspace: options.workspace,
    // 没有任务书,用命令默认超时的一半 —— 独立运行时不该挂太久
    timeoutMs: 120_000,
  });

  const fatalLint = fatalFindings(lintReport(report, undefined), undefined);
  const verdict = decideStatus({
    commandOutcomes: [],
    reproducibleOutcomes: [],
    replayOutcomes,
    fatalLint,
    statementVerdicts: [],
    unresolved: report.unresolved,
    noUnresolvedRequired: false,
    ...(report.blocked_reason === undefined ? {} : { blockedReason: report.blocked_reason }),
  });

  const evidenceRows = replayOutcomes.map((outcome) => {
    const evidence = report.claims[outcome.claimIndex]?.evidence[outcome.evidenceIndex];
    return {
      label: evidence === undefined ? `证据 #${outcome.claimIndex + 1}.${outcome.evidenceIndex + 1}` : labelOf(evidence),
      verdict: outcome.verdict,
      detail: outcome.detail,
    };
  });

  const human = [`${report.task}  ${verdict.status}`, ""];

  for (const row of evidenceRows) {
    const mark = row.verdict === "replayed" || row.verdict === "drifted" ? "✓" : "✗";
    human.push(`  ${mark} [${row.verdict}] \`${row.label}\``);
    if (row.verdict !== "replayed") human.push(`      ${row.detail.replace(/\n/g, "\n      ")}`);
  }

  for (const finding of fatalLint) {
    human.push(`  ✗ [${finding.rule}] ${finding.where}:${finding.detail}`);
  }

  human.push("", `裁定:${verdict.status}`);
  for (const reason of verdict.reasons) human.push(`  - ${reason}`);

  return {
    code: verdict.status === "contradicted" || verdict.status === "blocked" ? 1 : 0,
    human,
    json: {
      command: "verify",
      task: report.task,
      status: verdict.status,
      reasons: verdict.reasons,
      evidence: evidenceRows,
    },
  };
}

interface ChainJson {
  command: "chain";
  ok: boolean;
  length: number;
  brokenAt?: number;
  reason?: string;
}

async function checkChain(
  path: string,
  options: EvidenceCliOptions,
): Promise<{ code: number; json: ChainJson | null; human: string[] }> {
  const entries = await readProvenance(path);

  if (entries.length === 0) {
    return {
      code: 1,
      json: null,
      human: [`${path} 里没有可读的记录 —— 要么文件不存在,要么每一行都不是合法 JSON。`],
    };
  }

  const check = verifyChain(entries);
  const human = check.ok
    ? [`${path}:${check.length} 条,链完整。`]
    : [`${path}:第 ${check.brokenAt} 条断了 —— ${check.reason}`];

  return {
    code: check.ok ? 0 : 1,
    human,
    json: {
      command: "chain",
      ok: check.ok,
      length: check.length,
      ...(check.brokenAt === undefined ? {} : { brokenAt: check.brokenAt }),
      ...(check.reason === undefined ? {} : { reason: check.reason }),
    },
  };
}

interface TraceJson {
  command: "trace";
  file: string;
  traceable: boolean;
  how?: string;
  detail: string;
}

async function traceFile(
  provenancePath: string,
  file: string,
  options: EvidenceCliOptions,
): Promise<{ code: number; json: TraceJson; human: string[] }> {
  const target = resolve(options.workspace, file);
  const result = await traceInput(provenancePath, target);

  return {
    code: result.traceable ? 0 : 1,
    human: [`${file}  ${result.traceable ? "可溯源" : "不可溯源"}:${result.detail}`],
    json: {
      command: "trace",
      file,
      traceable: result.traceable,
      ...(result.how === undefined ? {} : { how: result.how }),
      detail: result.detail,
    },
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runEvidenceCommand(
  positional: string[],
  options: EvidenceCliOptions,
): Promise<number> {
  const [sub, ...rest] = positional;

  if (sub === undefined || sub === "help" || sub === "--help") {
    console.log(USAGE);
    return sub === undefined ? 1 : 0;
  }

  if (sub === "verify") {
    const path = rest[0];
    if (path === undefined) {
      console.error("要验哪份报告?比如:mastic evidence verify reports/T-001.md");
      return 1;
    }

    const result = await verifyReport(path, options);
    if (options.json && result.json !== null) printJson(result.json);
    else for (const line of result.human) console.log(line);
    return result.code;
  }

  if (sub === "chain") {
    const path = rest[0];
    if (path === undefined) {
      console.error("要验哪条链?比如:mastic evidence chain .mastic/runs/r1/provenance.jsonl");
      return 1;
    }

    const result = await checkChain(path, options);
    if (options.json && result.json !== null) printJson(result.json);
    else for (const line of result.human) console.log(line);
    return result.code;
  }

  if (sub === "trace") {
    const [path, file] = rest;
    if (path === undefined || file === undefined) {
      console.error("用法:mastic evidence trace <provenance.jsonl> <file>");
      return 1;
    }

    const result = await traceFile(path, file, options);
    if (options.json) printJson(result.json);
    else for (const line of result.human) console.log(line);
    return result.code;
  }

  console.error(`还不认识 \`evidence ${sub}\`。\n`);
  console.log(USAGE);
  return 1;
}
