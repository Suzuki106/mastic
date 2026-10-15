import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { replayEvidence } from "../src/check/replay.ts";
import type { Evidence, ReportDoc } from "../src/doc/report.ts";
import { runCommand } from "../src/exec.ts";

const workspace = await mkdtemp(join(tmpdir(), "mastic-replay-"));
const timeoutMs = 10_000;

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function reportWith(evidence: Evidence[]): ReportDoc {
  return {
    task: "T-001",
    status: "unverified",
    claims: [{ statement: "测试用", evidence }],
    files_changed: [],
    unresolved: [],
    body: "",
  };
}

async function verdictOf(evidence: Evidence): Promise<string> {
  const outcomes = await replayEvidence(reportWith([evidence]), { workspace, timeoutMs });
  return outcomes[0]?.verdict ?? "(没有结论)";
}

const FAKE_HASH = "d".repeat(64);

describe("证据重放", () => {
  it("稳定命令 + 对得上的哈希 → replayed", async () => {
    const real = await runCommand("echo hello", { cwd: workspace, timeoutMs });
    const verdict = await verdictOf({
      kind: "command",
      run: "echo hello",
      cwd: ".",
      exit_code: real.exitCode,
      stdout_sha256: real.stdoutSha256,
    });
    assert.equal(verdict, "replayed");
  });

  // 这是项目的核心承诺:编出来的哈希过不去。
  it("稳定命令 + 编造的哈希 → contradicted,而不是含糊的 drifted", async () => {
    const verdict = await verdictOf({
      kind: "command",
      run: "echo hello",
      cwd: ".",
      exit_code: 0,
      stdout_sha256: FAKE_HASH,
    });
    assert.equal(verdict, "contradicted");
  });

  // 反过来,老实的证据不该被冤枉:输出里带纳秒,两次必然不同。
  it("本身就不稳定的命令 → drifted,不指控 worker 说谎", async () => {
    const verdict = await verdictOf({
      kind: "command",
      run: "date +%s%N",
      cwd: ".",
      exit_code: 0,
      stdout_sha256: FAKE_HASH,
    });
    assert.equal(verdict, "drifted");
  });

  it("退出码对不上 → contradicted", async () => {
    const verdict = await verdictOf({
      kind: "command",
      run: "exit 3",
      cwd: ".",
      exit_code: 0,
      stdout_sha256: FAKE_HASH,
    });
    assert.equal(verdict, "contradicted");
  });

  it("文件哈希对不上 → contradicted", async () => {
    const verdict = await verdictOf({
      kind: "file",
      path: "并不存在的文件.txt",
      sha256: FAKE_HASH,
    });
    assert.equal(verdict, "contradicted");
  });

  it("URL 证据不可重放,只能停在 unverified", async () => {
    const verdict = await verdictOf({ kind: "url", url: "https://example.com" });
    assert.equal(verdict, "unreplayable");
  });

  it("路径穿越被挡住", async () => {
    const verdict = await verdictOf({
      kind: "file",
      path: "../../etc/passwd",
      sha256: FAKE_HASH,
    });
    assert.equal(verdict, "contradicted");
  });
});
