import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { replayEvidence } from "../src/check/replay.ts";
import type { Evidence, ReportDoc } from "../src/doc/report.ts";
import { runCommand, sha256File } from "../src/exec.ts";

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
   * 记录之后工作区变了 —— 归因应当指向那个变过的输入。
   *
   * 真实跑出来过:worker 记了 `ls -R src`,然后自己往 src 下建了文件,
   * 重放自然对不上。有了输入快照之后,至少能说出是哪个文件变了,
   * 而不是笼统地"分不清"。
   */
  it("记录之后输入变了:照样拦下,但归因指向变过的文件", async () => {
    await writeFile(join(workspace, "attribution.txt"), "v1\n", "utf8");
    const recorded = await sha256File(join(workspace, "attribution.txt"));
    const before = await runCommand("cat attribution.txt", { cwd: workspace, timeoutMs });

    await writeFile(join(workspace, "attribution.txt"), "v2\n", "utf8");

    const outcomes = await replayEvidence(
      reportWith([
        {
          kind: "command",
          run: "cat attribution.txt",
          cwd: ".",
          exit_code: before.exitCode,
          stdout_sha256: before.stdoutSha256,
          inputs: [{ path: "attribution.txt", sha256: recorded }],
        },
      ]),
      { workspace, timeoutMs },
    );

    const outcome = outcomes[0];
    assert.equal(outcome?.verdict, "contradicted");
    assert.ok(outcome?.detail.includes("这些输入变过"), `应当归因到输入,实际:${outcome?.detail}`);
    assert.ok(outcome?.detail.includes("attribution.txt"), "应当点名那个文件");
    assert.ok(!outcome?.detail.includes("编的"), "输入确实变了,不该指控说谎");
  });

  it("输入没变却对不上:归因指向记录本身", async () => {
    await writeFile(join(workspace, "stable.txt"), "内容固定\n", "utf8");
    const recorded = await sha256File(join(workspace, "stable.txt"));
    const real = await runCommand("cat stable.txt", { cwd: workspace, timeoutMs });

    const outcomes = await replayEvidence(
      reportWith([
        {
          kind: "command",
          run: "cat stable.txt",
          cwd: ".",
          exit_code: real.exitCode,
          stdout_sha256: FAKE_HASH,
          inputs: [{ path: "stable.txt", sha256: recorded }],
        },
      ]),
      { workspace, timeoutMs },
    );

    const outcome = outcomes[0];
    assert.equal(outcome?.verdict, "contradicted");
    assert.ok(outcome?.detail.includes("都没变"), `应当说明输入没变,实际:${outcome?.detail}`);
    assert.ok(outcome?.detail.includes("记录本身不实"), "输入没变时,矛头应当指向记录");
  });

  it("没有输入快照时诚实地说无法归因", async () => {
    const verdict = await replayEvidence(
      reportWith([
        {
          kind: "command",
          run: "echo hello",
          cwd: ".",
          exit_code: 0,
          stdout_sha256: FAKE_HASH,
        },
      ]),
      { workspace, timeoutMs },
    );

    assert.ok(verdict[0]?.detail.includes("无法归因"), verdict[0]?.detail);
  });
});
