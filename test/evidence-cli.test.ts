import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runEvidenceCommand } from "../src/evidence/cli.ts";
import { runCommand, sha256File } from "../src/exec.ts";
import { appendProvenance } from "../src/provenance.ts";

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastic-evidence-cli-"));
  roots.push(dir);
  return dir;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    return { code: await fn(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function report(sha256: string): string {
  return `---
task: T-EXAMPLE
status: unverified
claims:
  - statement: 跑过
    evidence:
      - kind: command
        run: "echo hello"
        cwd: "."
        exit_code: 0
        stdout_sha256: ${sha256}
unresolved: []
---
`;
}

describe("mastic evidence", () => {
  it("诚实的外部报告 → verified", async () => {
    const workspace = await tempDir();
    const real = await runCommand("echo hello", { cwd: workspace, timeoutMs: 5_000 });
    const path = join(workspace, "report.md");
    await writeFile(path, report(real.stdoutSha256), "utf8");

    const { code, output } = await capture(() =>
      runEvidenceCommand(["verify", path], { workspace, json: true }),
    );

    assert.equal(code, 0);
    assert.equal((JSON.parse(output) as { status: string }).status, "verified");
  });

  it("伪造哈希 → contradicted,退出码 1", async () => {
    const workspace = await tempDir();
    const path = join(workspace, "report.md");
    await writeFile(path, report("d".repeat(64)), "utf8");

    const { code, output } = await capture(() =>
      runEvidenceCommand(["verify", path], { workspace, json: true }),
    );

    assert.equal(code, 1);
    assert.equal((JSON.parse(output) as { status: string }).status, "contradicted");
  });

  it("格式不合格的报告 → 退出码 1,并指出哪里不合格", async () => {
    const workspace = await tempDir();
    const path = join(workspace, "bad.md");
    await writeFile(path, "---\ntask: T-1\n---\n", "utf8");

    const { code, output } = await capture(() =>
      runEvidenceCommand(["verify", path], { workspace, json: false }),
    );

    assert.equal(code, 1);
    assert.ok(output.includes("不是合格的报告"));
  });

  it("完整的溯源链 → 0;改过中间一条 → 1", async () => {
    const workspace = await tempDir();
    const chain = join(workspace, "provenance.jsonl");

    await appendProvenance(chain, { kind: "note", note: "第一条" });
    await appendProvenance(chain, { kind: "note", note: "第二条" });

    const ok = await capture(() => runEvidenceCommand(["chain", chain], { workspace, json: false }));
    assert.equal(ok.code, 0);
    assert.ok(ok.output.includes("链完整"));

    const text = await readFile(chain, "utf8");
    const lines = text.trimEnd().split("\n");
    lines[0] = lines[0]!.replace("第一条", "被改过");
    await writeFile(chain, `${lines.join("\n")}\n`, "utf8");

    const broken = await capture(() => runEvidenceCommand(["chain", chain], { workspace, json: false }));
    assert.equal(broken.code, 1);
    assert.ok(broken.output.includes("断了"));
  });

  it("溯源查到来源 → 0;查不到 → 1", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "tiny.csv"), "a,b\n", "utf8");
    await writeFile(join(workspace, "data", "invented.csv"), "1,2\n", "utf8");

    const chain = join(workspace, "provenance.jsonl");
    await appendProvenance(chain, {
      kind: "fetch",
      url: "https://example.com/tiny.csv",
      sha256: await sha256File(join(workspace, "data", "tiny.csv")),
    });

    const found = await capture(() =>
      runEvidenceCommand(["trace", chain, "data/tiny.csv"], { workspace, json: false }),
    );
    assert.equal(found.code, 0);
    assert.ok(found.output.includes("可溯源"));

    const missing = await capture(() =>
      runEvidenceCommand(["trace", chain, "data/invented.csv"], { workspace, json: false }),
    );
    assert.equal(missing.code, 1);
    assert.ok(missing.output.includes("不可溯源"));
  });
});
