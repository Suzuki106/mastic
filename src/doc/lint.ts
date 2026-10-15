import type { ReportDoc } from "./report.ts";
import type { StructuralRule, TaskDoc } from "./task.ts";

export interface LintFinding {
  rule: StructuralRule;
  /** 出问题的位置,例如 `claims[2].statement`。 */
  where: string;
  detail: string;
}

/**
 * 出现即视为「在编」的词。
 *
 * 这是四道反 mock 闸里最便宜的一道 —— 不指望它抓住所有情况,它抓的是
 * 证据重放抓不到的那类残留:数字都对,但结论其实是猜的。
 *
 * 误报的出口是任务书里的 `allow_terms`,不是放宽这张表。任务本身
 * 就是「写一个 mock server」时,由那份任务书显式声明豁免,人能看见。
 *
 * 这里**没有** TODO / FIXME。它们不是"在编",是"没写完"—— 是另一回事,
 * 而且 `node --test` 的输出里就有一行 `ℹ todo 0`,放进这张表必然误伤
 * 每一份引用测试输出的报告。
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  // 中文 —— 无词边界,按子串匹配
  "假设",
  "假定",
  "模拟",
  "假装",
  "伪造",
  "捏造",
  "猜测",
  "大概是",
  "应该是",
  "估计是",
  "理论上",
  "占位",
  "先这样",
  "待补",
  // 英文 —— 按前缀词边界匹配,所以 assume 也覆盖 assumes / assumed
  "assume",
  "assumption",
  "mock",
  "simulate",
  "simulation",
  "placeholder",
  "stub",
  "dummy",
  "fake",
  "fabricat",
  "hypothetical",
  "presumably",
  "handwave",
];

/**
 * 这两条是项目的脊梁,任何任务都绕不过去 ——
 * 即使任务书一个字没写,它们也永远是致命的。
 */
export const ALWAYS_FATAL: readonly StructuralRule[] = ["evidence_for_every_claim", "no_forbidden_words"];

/** 致命规则集 = 脊梁两条 ∪ 任务书声明要的。 */
export function fatalRules(task: TaskDoc | undefined): Set<StructuralRule> {
  const rules = new Set<StructuralRule>(ALWAYS_FATAL);

  for (const check of task?.acceptance ?? []) {
    if (check.kind !== "structural") continue;
    for (const rule of check.require) rules.add(rule);
  }

  return rules;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Matcher {
  term: string;
  pattern: RegExp | null;
}

/**
 * 含拉丁字母的词按「前缀词边界」匹配:左边界卡死,右边界放开。
 * 于是 `stub` 能命中 `stubs` / `stubbed`,而不会命中 `obstub` 这种半截词。
 * 纯 CJK 词没有词边界可言,退回子串匹配。
 */
const MATCHERS: readonly Matcher[] = FORBIDDEN_TERMS.map((term) => ({
  term,
  pattern: /^[A-Za-z]+$/.test(term) ? new RegExp(`\\b${escapeRegExp(term)}`, "i") : null,
}));

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 20);
  const end = Math.min(text.length, at + length + 20);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ")}${suffix}`;
}

interface Span {
  where: string;
  text: string;
}

/**
 * 去掉围栏代码块与行内代码。
 *
 * **引用不是主张。** 报告里贴的命令原文、测试输出、文件正文,是证据,不是
 * 作者在表态。`node --test` 的输出里天然带着 `ℹ todo 0`,命令里天然带着
 * `grep -E "…|todo"` —— 拿这些去判"作者在编",只会把每份老实报告都毙掉。
 *
 * 只看作者用自己的话写的那部分。
 */
export function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** 报告里所有需要过禁词筛的文本。 */
function spans(report: ReportDoc): Span[] {
  const all: Span[] = [{ where: "正文", text: stripQuoted(report.body) }];

  report.claims.forEach((claim, index) => {
    all.push({ where: `claims[${index}].statement`, text: stripQuoted(claim.statement) });
    claim.evidence.forEach((evidence, evidenceIndex) => {
      if (evidence.note !== undefined) {
        all.push({
          where: `claims[${index}].evidence[${evidenceIndex}].note`,
          text: stripQuoted(evidence.note),
        });
      }
    });
  });

  report.unresolved.forEach((item, index) => {
    all.push({ where: `unresolved[${index}]`, text: stripQuoted(item) });
  });

  return all;
}

export function lintReport(report: ReportDoc, task: TaskDoc | undefined): LintFinding[] {
  const findings: LintFinding[] = [];
  const allowed = new Set((task?.allow_terms ?? []).map((term) => term.toLowerCase()));

  for (const span of spans(report)) {
    for (const { term, pattern } of MATCHERS) {
      if (allowed.has(term.toLowerCase())) continue;

      const at = pattern === null ? span.text.indexOf(term) : (pattern.exec(span.text)?.index ?? -1);
      if (at === -1) continue;

      findings.push({
        rule: "no_forbidden_words",
        where: span.where,
        detail: `出现「${term}」:${snippet(span.text, at, term.length)}`,
      });
    }
  }

  report.claims.forEach((claim, index) => {
    if (claim.evidence.length === 0) {
      findings.push({
        rule: "evidence_for_every_claim",
        where: `claims[${index}]`,
        detail: `「${claim.statement.slice(0, 40)}」没有任何证据。`,
      });
    }
  });

  // `no_unresolved` 不在这里判 —— 有未解决项该不该算硬伤,取决于任务书要不要求,
  // 那是 verdict 的事。放这儿会和它重复计一次。

  if (task !== undefined && report.task !== task.id) {
    findings.push({
      rule: "deliverable_matches_task",
      where: "task",
      detail: `报告自称是 \`${report.task}\` 的,但任务书是 \`${task.id}\` —— 交错了。`,
    });
  }

  return findings;
}

/** 按致命规则集挑出真正会拦下这份报告的条目。 */
export function fatalFindings(findings: LintFinding[], task: TaskDoc | undefined): LintFinding[] {
  const fatal = fatalRules(task);
  return findings.filter((finding) => fatal.has(finding.rule));
}
