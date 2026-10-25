import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { verify } from "../src/agent/verifier.ts";
import type { Config } from "../src/config.ts";
import { parseReportDoc, type ReportDoc } from "../src/doc/report.ts";
import { parseTaskDoc, type TaskDoc } from "../src/doc/task.ts";
import { createLedger, recordFile } from "../src/ledger.ts";
import { appendProvenance } from "../src/provenance.ts";
import { sha256File } from "../src/exec.ts";

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastic-verifier-"));
  roots.push(dir);
  return dir;
}

function config(workspace: string): Config {
  return {
    apiKey: "offline",
    baseUrl: "http://unused.invalid",
    model: "offline",
    workspace,
    concurrency: 1,
    maxRetries: 0,
    plannerSteps: 5,
    runBudgetSteps: 20,
    taskStepCeiling: 10,
    commandTimeoutMs: 5_000,
    requestIdleTimeoutMs: 1_000,
    vision: false,
    mcp: false,
    skills: false,
  };
}

function task(): TaskDoc {
  const parsed = parseTaskDoc(`---
id: T-001
title: 原始数据区
goal: 验证用户数据不会被误伤
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
---
`);
  if (parsed.task === undefined) throw new Error(parsed.errors.join("; "));
  return parsed.task;
}

async function reportFor(workspace: string): Promise<ReportDoc> {
  await writeFile(join(workspace, "artifact.txt"), "x\n", "utf8");
  const parsed = parseReportDoc(`---
task: T-001
status: unverified
claims:
  - statement: 产物在这儿
    evidence:
      - kind: file
        path: "artifact.txt"
        sha256: ${await sha256File(join(workspace, "artifact.txt"))}
unresolved: []
---
`);
  if (parsed.report === undefined) throw new Error(parsed.errors.join("; "));
  return parsed.report;
}

async function statusOf(
  workspace: string,
  preexisting: string[],
): Promise<string> {
  const runRoot = join(workspace, ".mastic", "runs", "r1");
  await mkdir(runRoot, { recursive: true });

  const ledger = createLedger();
  recordFile(ledger, {
    path: "data/user.csv",
    sha256: await sha256File(join(workspace, "data", "user.csv")),
    action: "read",
  });

  const result = await verify({
    config: config(workspace),
    task: task(),
    report: await reportFor(workspace),
    workspace,
    runRoot,
    ledger,
    preexistingData: preexisting,
    timeoutMs: 5_000,
  });

  return result.verdict.status;
}

describe("原始数据区", () => {
  it("用户动手前就放在 data/ 里的文件,不该被当成伪造观测", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "user.csv"), "u,v\n", "utf8");

    assert.equal(await statusOf(workspace, ["data/user.csv"]), "verified");
  });

  it("运行期间新塞进 data/、又没有来源的文件 → contradicted", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "user.csv"), "u,v\n", "utf8");
    await writeFile(join(workspace, "data", "invented.csv"), "1,2\n", "utf8");

    assert.equal(await statusOf(workspace, ["data/user.csv"]), "contradicted");
  });

  it("抓来的文件登记在溯源链上 → 不误伤", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "data"), { recursive: true });
    await writeFile(join(workspace, "data", "user.csv"), "u,v\n", "utf8");

    const runRoot = join(workspace, ".mastic", "runs", "r1");
    await mkdir(runRoot, { recursive: true });
    await appendProvenance(join(runRoot, "provenance.jsonl"), {
      kind: "fetch",
      url: "https://example.com/user.csv",
      sha256: await sha256File(join(workspace, "data", "user.csv")),
    });

    assert.equal(await statusOf(workspace, []), "verified");
  });
});
