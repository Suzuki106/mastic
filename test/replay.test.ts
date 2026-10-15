import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  /**
   * 已知边界,不是 bug 而是说不清:命令现在稳定、记录却对不上时,
   * "工作区变了"和"这个数是编的"在重放这一侧无法区分。
   *
   * 真实跑出来过 —— worker 记了 `ls -R src`,然后自己往 src 下建了文件,
   * 重放自然对不上。裁定仍然拦下它(这条证据确实不能作数),但措辞不能
   * 指控说谎。
   */
  it("记录之后工作区变了:照样拦下,但措辞不说'编的'", async () => {
    const before = await runCommand("ls", { cwd: workspace, timeoutMs });
    await writeFile(join(workspace, "后来加的文件.txt"), "x", "utf8");

    const outcomes = await replayEvidence(
      reportWith([
        {
          kind: "command",
          run: "ls",
          cwd: ".",
          exit_code: before.exitCode,
          stdout_sha256: before.stdoutSha256,
        },
      ]),
      { workspace, timeoutMs },
    );

    const outcome = outcomes[0];
    assert.equal(outcome?.verdict, "contradicted");
    // 它两次新跑是一致的,所以确实是"稳定但与记录不符"那一档
    assert.ok(outcome?.detail.includes("分不清是哪种"), `措辞应当承认分不清,实际:${outcome?.detail}`);
    assert.ok(!outcome?.detail.includes("报告里那个数是编的"), "不该断言就是说谎");
  });
});
