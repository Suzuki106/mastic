import { DocError, parseDoc, serialiseDoc } from "./frontmatter.ts";
import {
  describe,
  isRecord,
  readArray,
  readEnum,
  readInt,
  readString,
  readStringArray,
  type Problems,
} from "./validate.ts";

/**
 * 交付报告的终态。由 **verifier 裁定**,不由 worker 自报 ——
 * worker 提交的是主张,verifier 落的是裁定。
 *
 *   verified      所有验收通过,且每条 claim 的证据都重放成功
 *   unverified    没有失败项,但有东西没验成 —— 合法终态,会显式列出
 *   contradicted  某项验收失败,或证据重放对不上 —— 不可以被忽略
 *   blocked       走不下去(缺输入 / 需要人拍板)
 */
export const REPORT_STATUSES = ["verified", "unverified", "contradicted", "blocked"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const EVIDENCE_KINDS = ["command", "file", "url"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** 记录这条命令时,worker 已经读过的文件及其当时的哈希 —— 归因重放靠它。 */
export interface EvidenceInput {
  path: string;
  sha256: string;
}

/** 跑一条命令留下的痕迹。verifier 会照着这里重跑一遍比对。 */
export interface CommandEvidence {
  kind: "command";
  run: string;
  cwd: string;
  exit_code: number;
  stdout_sha256: string;
  stdout_bytes?: number;
  /**
   * 执行这条命令前的已读文件快照。
   *
   * 它不是完整依赖集,只是 mastic 确实看见过的那部分输入。重放对不上时,
   * 用它区分「记录之后输入变了」和「输入没变,记录本身不实」。
   */
  inputs?: EvidenceInput[];
  note?: string;
}

/** 一个文件在某时刻的哈希。verifier 重新哈希一遍比对。 */
export interface FileEvidence {
  kind: "file";
  path: string;
  sha256: string;
  note?: string;
}

/**
 * 外部 URL。**不可重放** —— 内容随时间变,重取一次无法证明当时看到了什么。
 * 所以它永远只能支撑到 unverified,撑不到 verified。这是刻意的。
 */
export interface UrlEvidence {
  kind: "url";
  url: string;
  http_status?: number;
  note?: string;
}

export type Evidence = CommandEvidence | FileEvidence | UrlEvidence;

export interface Claim {
  statement: string;
  /** 至少一条。没有证据的声明在解析阶段就会被拒 —— 根本写不出来。 */
  evidence: Evidence[];
}

export const FILE_ACTIONS = ["created", "modified", "deleted"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export interface FileChange {
  path: string;
  action: FileAction;
}

/**
 * 一条判据的结论。前端就是靠这个逐条渲染的。
 *
 * `caveat` 是给"过了、但有话要说"用的 —— 典型是证据退出码对上了、
 * 输出却不是逐字节可复现。它不改状态,只是让人看见。
 */
export interface CheckReport {
  kind: "command" | "evidence" | "statement" | "lint" | "reproducible";
  label: string;
  passed: boolean;
  detail: string;
  caveat?: boolean;
}

/** 裁定留痕:谁在什么时候、依据什么、把状态定成了什么。 */
export interface VerdictReport {
  decided_at: string;
  reasons: string[];
  checks: CheckReport[];
}

export interface ReportDoc {
  task: string;
  status: ReportStatus;
  claims: Claim[];
  files_changed: FileChange[];
  unresolved: string[];
  /** worker 认为走不下去时的原因。它唯一能表达「没做成」的地方。 */
  blocked_reason?: string;
  /** 由 verifier 写。worker 交上来的草稿里没有这一项。 */
  verdict?: VerdictReport;
  body: string;
}

export interface ReportParseResult {
  report?: ReportDoc;
  errors: string[];
}

function parseEvidence(raw: unknown[], errors: Problems, where: string): Evidence[] {
  return raw.flatMap((item, index): Evidence[] => {
    const at = `${where}.evidence[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${at} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const kind = readEnum(item, "kind", errors, EVIDENCE_KINDS);
    if (kind === undefined) return [];

    const note = readString(item, "note", errors, { required: false });

    if (kind === "command") {
      const run = readString(item, "run", errors);
      const sha = readString(item, "stdout_sha256", errors);
      if (run === undefined || sha === undefined) {
        errors.push(`${at} 是 command 证据,必须给 \`run\` 和 \`stdout_sha256\`(重放时要靠它对账)。`);
        return [];
      }
      const evidence: CommandEvidence = {
        kind: "command",
        run,
        cwd: readString(item, "cwd", errors, { fallback: "." }) ?? ".",
        exit_code: readInt(item, "exit_code", errors, 0),
        stdout_sha256: sha,
      };
      const bytes = readInt(item, "stdout_bytes", errors, -1);
      if (bytes >= 0) evidence.stdout_bytes = bytes;

      // 归因输入是 mastic 自己写的,读不回来也不能让整份报告打不开
      if (Array.isArray(item.inputs)) {
        const inputs = item.inputs.flatMap((entry): EvidenceInput[] => {
          if (!isRecord(entry)) return [];
          if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") return [];
          return [{ path: entry.path, sha256: entry.sha256 }];
        });
        if (inputs.length > 0) evidence.inputs = inputs.slice(0, 20);
      }
      if (note !== undefined) evidence.note = note;
      return [evidence];
    }

    if (kind === "file") {
      const path = readString(item, "path", errors);
      const sha = readString(item, "sha256", errors);
      if (path === undefined || sha === undefined) {
        errors.push(`${at} 是 file 证据,必须给 \`path\` 和 \`sha256\`。`);
        return [];
      }
      const evidence: FileEvidence = { kind: "file", path, sha256: sha };
      if (note !== undefined) evidence.note = note;
      return [evidence];
    }

    const url = readString(item, "url", errors);
    if (url === undefined) {
      errors.push(`${at} 是 url 证据,必须给 \`url\`。`);
      return [];
    }
    const evidence: UrlEvidence = { kind: "url", url };
    const status = readInt(item, "http_status", errors, -1);
    if (status >= 0) evidence.http_status = status;
    if (note !== undefined) evidence.note = note;
    return [evidence];
  });
}

function parseClaims(raw: unknown[], errors: Problems): Claim[] {
  return raw.flatMap((item, index) => {
    const where = `claims[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${where} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const statement = readString(item, "statement", errors);
    if (statement === undefined) return [];

    const evidence = parseEvidence(readArray(item, "evidence", errors, { required: true }), errors, where);

    // 反 mock 的第一道闸:没有证据的声明不是"质量差",是根本不合法。
    if (evidence.length === 0) {
      errors.push(
        `${where} 没有任何证据。要么补上可重放的证据(命令 / 文件哈希),` +
          `要么把这条从 claims 移到 unresolved —— 二选一,不能悬着。`,
      );
      return [];
    }

    return [{ statement, evidence }];
  });
}

function parseFilesChanged(raw: unknown[], errors: Problems): FileChange[] {
  return raw.flatMap((item, index) => {
    const where = `files_changed[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const path = readString(item, "path", errors);
    const action = readEnum(item, "action", errors, FILE_ACTIONS);
    if (path === undefined || action === undefined) return [];

    return [{ path, action }];
  });
}

export function parseReportDoc(raw: string): ReportParseResult {
  let parsed: ReturnType<typeof parseDoc>;
  try {
    parsed = parseDoc(raw);
  } catch (error) {
    if (error instanceof DocError) return { errors: [error.message] };
    throw error;
  }

  const errors: Problems = [];
  const { data } = parsed;

  const report: ReportDoc = {
    task: readString(data, "task", errors) ?? "",
    status: readEnum(data, "status", errors, REPORT_STATUSES, "unverified") ?? "unverified",
    claims: parseClaims(readArray(data, "claims", errors, { required: true }), errors),
    files_changed: parseFilesChanged(readArray(data, "files_changed", errors), errors),
    unresolved: readStringArray(data, "unresolved", errors),
    body: parsed.body,
  };

  if (report.claims.length === 0 && !errors.some((e) => e.startsWith("claims"))) {
    errors.push("`claims` 是空的 —— 一份什么都没主张的报告等于没干活。");
  }

  const blockedReason = readString(data, "blocked_reason", errors, { required: false });
  if (blockedReason !== undefined) report.blocked_reason = blockedReason;

  const verdict = parseVerdict(data.verdict);
  if (verdict !== undefined) report.verdict = verdict;

  if (errors.length > 0) return { errors };
  return { report, errors: [] };
}

/**
 * 裁定是 mastic 自己写的,读回来时宽松处理:认不出来就当没有,
 * 不因为一个附加字段的格式问题阻塞整份报告的读取。
 */
function parseVerdict(raw: unknown): VerdictReport | undefined {
  if (!isRecord(raw)) return undefined;

  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((item): item is string => typeof item === "string")
    : [];

  const checks: CheckReport[] = Array.isArray(raw.checks)
    ? raw.checks.flatMap((item): CheckReport[] => {
        if (!isRecord(item)) return [];
        const kind = item.kind;
        if (
          kind !== "command" &&
          kind !== "evidence" &&
          kind !== "statement" &&
          kind !== "lint" &&
          kind !== "reproducible"
        ) {
          return [];
        }
        const check: CheckReport = {
          kind,
          label: typeof item.label === "string" ? item.label : "",
          passed: item.passed === true,
          detail: typeof item.detail === "string" ? item.detail : "",
        };
        if (item.caveat === true) check.caveat = true;
        return [check];
      })
    : [];

  return {
    decided_at: typeof raw.decided_at === "string" ? raw.decided_at : "",
    reasons,
    checks,
  };
}

/* ────────────────────────────────────────────────────────────────
 * 起草态
 *
 * worker 交回来的不是成品报告,是一份**草稿**:证据只写台账编号,
 * 数字一个都不写。它没有可以编造的字段。
 *
 * 最关键的是草稿里**没有 status** —— worker 根本没资格说「完成」。
 * 它只能说「我卡住了」(blocked),或者什么都不说,由 verifier 去判。
 * ──────────────────────────────────────────────────────────────── */

export interface EvidenceDraft {
  /** 台账编号:`C3` 是第 3 条命令,`F2` 是第 2 个文件。 */
  ref: string;
  note?: string;
}

export interface ClaimDraft {
  statement: string;
  evidence: EvidenceDraft[];
}

export interface ReportDraft {
  task: string;
  claims: ClaimDraft[];
  unresolved: string[];
  /** 走不下去时写这里 —— 这是 worker 唯一能表达「没做成」的方式。 */
  blocked?: string;
  body: string;
}

export interface DraftParseResult {
  draft?: ReportDraft;
  errors: string[];
}

const REF_PATTERN = /^[CF]\d+$/;

function parseEvidenceDrafts(raw: unknown[], errors: Problems, where: string): EvidenceDraft[] {
  return raw.flatMap((item, index): EvidenceDraft[] => {
    const at = `${where}.evidence[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${at} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const ref = readString(item, "ref", errors);
    if (ref === undefined) return [];

    if (!REF_PATTERN.test(ref)) {
      errors.push(`${at} 的 \`ref\` 得是台账编号(形如 \`C1\` 或 \`F2\`),收到 \`${ref}\``);
      return [];
    }

    const evidence: EvidenceDraft = { ref: ref.toUpperCase() };
    const note = readString(item, "note", errors, { required: false });
    if (note !== undefined) evidence.note = note;
    return [evidence];
  });
}

export function parseReportDraft(raw: string): DraftParseResult {
  let parsed: ReturnType<typeof parseDoc>;
  try {
    parsed = parseDoc(raw);
  } catch (error) {
    if (error instanceof DocError) return { errors: [error.message] };
    throw error;
  }

  const errors: Problems = [];
  const { data } = parsed;

  const claims = readArray(data, "claims", errors, { required: true }).flatMap(
    (item, index): ClaimDraft[] => {
      const where = `claims[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${where} 必须是 key: value 块,收到 ${describe(item)}`);
        return [];
      }

      const statement = readString(item, "statement", errors);
      if (statement === undefined) return [];

      const evidence = parseEvidenceDrafts(
        readArray(item, "evidence", errors, { required: true }),
        errors,
        where,
      );

      if (evidence.length === 0) {
        errors.push(
          `${where} 没有任何证据。要么引用台账编号(先真跑一遍命令 / 真写过文件),` +
            `要么把这条挪到 unresolved —— 二选一,不能悬着。`,
        );
        return [];
      }

      return [{ statement, evidence }];
    },
  );

  // files_changed 不在这里读 —— 它由台账推出来,见 ledger.ts 的 deriveFilesChanged。
  const draft: ReportDraft = {
    task: readString(data, "task", errors) ?? "",
    claims,
    unresolved: readStringArray(data, "unresolved", errors),
    body: parsed.body,
  };

  const blocked = readString(data, "blocked", errors, { required: false });
  if (blocked !== undefined) draft.blocked = blocked;

  if (draft.claims.length === 0 && !errors.some((e) => e.startsWith("claims"))) {
    errors.push("`claims` 是空的 —— 一份什么都没主张的报告等于没干活。");
  }

  if (errors.length > 0) return { errors };
  return { draft, errors: [] };
}

export function reportToData(report: ReportDoc): Record<string, unknown> {
  const data: Record<string, unknown> = {
    task: report.task,
    status: report.status,
    claims: report.claims.map((claim) => ({
      statement: claim.statement,
      evidence: claim.evidence,
    })),
    files_changed: report.files_changed,
    unresolved: report.unresolved,
  };

  if (report.blocked_reason !== undefined) data.blocked_reason = report.blocked_reason;
  if (report.verdict !== undefined) data.verdict = report.verdict;

  return data;
}

export function renderReportDoc(report: ReportDoc): string {
  return serialiseDoc(reportToData(report), report.body);
}
