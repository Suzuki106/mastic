/**
 * 框架无关的证据层。
 *
 * 这里的四个概念 —— 台账、重放、溯源链、裁定 —— 不需要 mastic 的 agent 循环
 * 也能用:任何运行时(另一个 agent 框架、一个 Python 脚本、CI 里的一步)
 * 只要按报告格式写出 `claims[].evidence[]`,就能被重放判定。
 *
 * 界限也在这里:**这一层只做机械判定**。它不规划、不调模型、不写任务书。
 * statement 级验收需要模型判断,不属于这个入口 —— 那部分留在 verifier 里,
 * 因为它本质上是"概率性意见",不是"确定性证据"。
 */

export {
  createLedger,
  deriveFilesChanged,
  findCommand,
  findFile,
  readInputs,
  recordCommand,
  recordFile,
  renderLedger,
  type CommandRecord,
  type FileRecord,
  type InputRecord,
  type Ledger,
} from "../ledger.ts";

export {
  replayEvidence,
  type ReplayOptions,
  type ReplayOutcome,
  type ReplayVerdict,
} from "../check/replay.ts";

export {
  GENESIS,
  appendProvenance,
  computeDigest,
  readProvenance,
  traceInput,
  verifyChain,
  type ChainCheck,
  type ProvenanceEntry,
  type ProvenanceKind,
  type TraceHow,
  type TraceResult,
} from "../provenance.ts";

export {
  parseReportDoc,
  renderReportDoc,
  type Claim,
  type CommandEvidence,
  type Evidence,
  type EvidenceInput,
  type FileEvidence,
  type ReportDoc,
  type UrlEvidence,
} from "../doc/report.ts";

export { decideStatus, type Verdict, type VerdictInput } from "../check/verdict.ts";
