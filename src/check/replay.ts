import type { Evidence, ReportDoc } from "../doc/report.ts";
import { runCommand, sha256File } from "../exec.ts";
import { resolveInside } from "../paths.ts";

/**
 * 单条证据的重放结果。
 *
 * `drifted` 和 `contradicted` 的界线是这里的要害:退出码对上了、哈希对不上,
 * 可能是「这条命令本来就不逐字节可复现」,也可能是「这个哈希是编的」——
 * 光看一次重放分不清这两者。
 *
 * 所以对不上的时候**再跑一次**:两次新跑如果互不相同,说明命令本身不稳定,
 * 判 drifted(软);两次新跑一模一样却和报告里的对不上,说明现实是可复现的、
 * 而报告里那个数是编的,判 contradicted(硬)。
 *
 * 编造的证据因此过不去,而带时间戳的老实证据也不会被冤枉。
 */
export type ReplayVerdict = "replayed" | "drifted" | "contradicted" | "unreplayable";

export interface ReplayOutcome {
  claimIndex: number;
  evidenceIndex: number;
  verdict: ReplayVerdict;
  detail: string;
}

export interface ReplayOptions {
  workspace: string;
  timeoutMs: number;
}

async function replayOne(
  evidence: Evidence,
  options: ReplayOptions,
): Promise<{ verdict: ReplayVerdict; detail: string }> {
  if (evidence.kind === "url") {
    return {
      verdict: "unreplayable",
      detail: `URL 内容随时间变,重取一次证明不了当时看到了什么 —— 只能标为未验证。`,
    };
  }

  if (evidence.kind === "file") {
    let path: string;
    try {
      path = resolveInside(options.workspace, evidence.path);
    } catch {
      return { verdict: "contradicted", detail: `路径 \`${evidence.path}\` 在工作目录外,拒绝读取。` };
    }

    let actual: string;
    try {
      actual = await sha256File(path);
    } catch {
      return { verdict: "contradicted", detail: `文件 \`${evidence.path}\` 不存在或读不到,哈希无从谈起。` };
    }

    if (actual !== evidence.sha256) {
      return {
        verdict: "contradicted",
        detail: `\`${evidence.path}\` 现在是 ${actual.slice(0, 12)}…,报告里写的是 ${evidence.sha256.slice(0, 12)}…`,
      };
    }

    return { verdict: "replayed", detail: `\`${evidence.path}\` 哈希对上了` };
  }

  let cwd: string;
  try {
    cwd = resolveInside(options.workspace, evidence.cwd);
  } catch {
    return { verdict: "contradicted", detail: `cwd \`${evidence.cwd}\` 在工作目录外,拒绝执行。` };
  }

  const first = await runCommand(evidence.run, { cwd, timeoutMs: options.timeoutMs });

  if (first.exitCode !== evidence.exit_code) {
    return {
      verdict: "contradicted",
      detail: `重放 \`${evidence.run}\` 退出码是 ${first.exitCode},报告里写的是 ${evidence.exit_code}`,
    };
  }

  if (first.stdoutSha256 === evidence.stdout_sha256) {
    return { verdict: "replayed", detail: `\`${evidence.run}\` 退出码与输出都对上了` };
  }

  // 对不上。再跑一次做判别实验:这条命令本身到底稳不稳定?
  const second = await runCommand(evidence.run, { cwd, timeoutMs: options.timeoutMs });

  if (second.stdoutSha256 !== first.stdoutSha256) {
    return {
      verdict: "drifted",
      detail:
        `\`${evidence.run}\` 输出不是逐字节可复现的 —— ` +
        `连着重跑两次自己都对不上(带时间戳/耗时),这条证据只能算未验全`,
    };
  }

  // 跑到这里:命令现在是稳定的,记录却对不上。可能是这个数被编了,
  // 也可能是记录之后工作区变了(比如那条命令 `ls -R src`,而 worker 随后
  // 就在 src 下建了新文件)。**分不清是哪种** —— 所以措辞只说事实,
  // 不指控说谎。但这条证据确实已经不能作数,该重做。
  return {
    verdict: "contradicted",
    detail:
      `\`${evidence.run}\` 连着重跑两次输出完全一致(它现在是稳定的),` +
      `但和报告里记的对不上。要么记录之后工作区变了(这条命令依赖了可变状态),` +
      `要么记录里那个数是编的 —— 分不清是哪种,但这条证据已经不能作数`,
  };
}

/** 把报告里每一条证据都真跑一遍。这是「编造的证据过不了」那句话的兑现。 */
export async function replayEvidence(report: ReportDoc, options: ReplayOptions): Promise<ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];

  for (const [claimIndex, claim] of report.claims.entries()) {
    for (const [evidenceIndex, evidence] of claim.evidence.entries()) {
      const { verdict, detail } = await replayOne(evidence, options);
      outcomes.push({ claimIndex, evidenceIndex, verdict, detail });
    }
  }

  return outcomes;
}
