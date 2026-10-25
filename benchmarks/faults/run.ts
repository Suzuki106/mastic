/**
 * 故障注入矩阵。
 *
 * 每个用例是一段**可复现的对抗脚本**:它故意犯一种错,然后走 mastic 真实的
 * 解析 / lint / 重放 / 裁定链路,看错误有没有被拦下。全部离线,不需要 API key。
 *
 * 与单元测试的区别:这里同时报告「没有验证层时会怎样」。单元测试证明某个函数
 * 的行为;这个矩阵回答的是「如果把这些主张直接当成完成,有多少会漏过去」。
 *
 * 跑法:`npm run test:faults`(加 `-- --json` 输出机器可读结果)。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskDoc, type TaskDoc } from "../../src/doc/task.ts";
import { parseReportDoc, renderReportDoc } from "../../src/doc/report.ts";
import { verify } from "../../src/agent/verifier.ts";
import { work } from "../../src/agent/worker.ts";
import type { ChatFn } from "../../src/agent/loop.ts";
import type { Config } from "../../src/config.ts";
import { validatePlan } from "../../src/doc/plan.ts";
import { createLedger, recordFile, type Ledger } from "../../src/ledger.ts";
import { runCommand, sha256File } from "../../src/exec.ts";
import { appendProvenance } from "../../src/provenance.ts";
import type { ChatResult } from "../../src/llm.ts";

const TIMEOUT = 10_000;
const FAKE_HASH = "d".repeat(64);

const config = (workspace: string): Config => ({
  apiKey: "offline",
  baseUrl: "http://unused.invalid",
  model: "offline",
  workspace,
  concurrency: 1,
  maxRetries: 0,
  plannerSteps: 5,
  runBudgetSteps: 20,
  taskStepCeiling: 10,
  commandTimeoutMs: TIMEOUT,
  requestIdleTimeoutMs: 1_000,
  vision: false,
  mcp: false,
  skills: false,
});

function task(acceptance = "true"): TaskDoc {
  const raw = `---
id: T-001
title: 故障注入用例
goal: 验证某种错误会不会被拦下
deliverable: reports/T-001.md
acceptance:
  - { kind: command, run: "${acceptance}", expect: { exit_code: 0 } }
---
`;
  const parsed = parseTaskDoc(raw);
  if (parsed.task === undefined) throw new Error(`用例任务书写错了:${parsed.errors.join("; ")}`);
  return parsed.task;
}

function reportYaml(evidence: string, body = "## 做了什么\n\n做了。\n"): string {
  return `---
task: T-001
status: unverified
claims:
  - statement: 做过这件事,证据在下面
    evidence:
${evidence}
unresolved: []
---

${body}`;
}

interface Context {
  workspace: string;
  runRoot: string;
}

async function context(): Promise<Context> {
  const workspace = await mkdtemp(join(tmpdir(), "mastic-fault-"));
  const runRoot = join(workspace, ".mastic", "runs", "fault");
  await mkdir(runRoot, { recursive: true });
  return { workspace, runRoot };
}

async function judge(
  ctx: Context,
  reportText: string,
  options: { task?: TaskDoc; ledger?: Ledger; preexisting?: string[] } = {},
): Promise<Outcome> {
  const { report } = parseReportDoc(reportText);
  if (report === undefined) return "report-rejected";

  const result = await verify({
    config: config(ctx.workspace),
    task: options.task ?? task(),
    report,
    workspace: ctx.workspace,
    runRoot: ctx.runRoot,
    ledger: options.ledger ?? createLedger(),
    preexistingData: options.preexisting ?? [],
    timeoutMs: TIMEOUT,
  });

  return result.verdict.status;
}

type Outcome =
  | "verified"
  | "unverified"
  | "contradicted"
  | "blocked"
  | "report-rejected"
  | "plan-rejected"
  | "no-report";

interface CaseResult {
  id: string;
  title: string;
  /** 没有验证层时,这份主张会不会被当成完成。 */
  naive: "accepted" | "not-accepted";
  /** 这一类是"应当被拦下"还是"老实证据不该被冤枉"。 */
  kind: "adversarial" | "honest" | "liveness";
  expected: Outcome[];
  actual: Outcome;
  detail: string;
}

interface FaultCase {
  id: string;
  title: string;
  naive: "accepted" | "not-accepted";
  kind: "adversarial" | "honest" | "liveness";
  expected: Outcome[];
  run(ctx: Context): Promise<{ actual: Outcome; detail: string }>;
}

const CASES: FaultCase[] = [
  {
    id: "honest-command",
    title: "诚实命令证据(对照组)",
    naive: "accepted",
    kind: "honest",
    expected: ["verified"],
    async run(ctx) {
      const real = await runCommand("echo hello", { cwd: ctx.workspace, timeoutMs: TIMEOUT });
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: command\n        run: "echo hello"\n        cwd: "."\n        exit_code: ${real.exitCode}\n        stdout_sha256: ${real.stdoutSha256}`,
        ),
      );
      return { actual, detail: `重放 ${real.stdoutSha256.slice(0, 12)}…` };
    },
  },
  {
    id: "fabricated-exit-code",
    title: "编造退出码(声称 0,实际 1)",
    naive: "accepted",
    kind: "adversarial",
    expected: ["contradicted"],
    async run(ctx) {
      const real = await runCommand("exit 1", { cwd: ctx.workspace, timeoutMs: TIMEOUT });
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: command\n        run: "exit 1"\n        cwd: "."\n        exit_code: 0\n        stdout_sha256: ${real.stdoutSha256}`,
        ),
      );
      return { actual, detail: `实际退出码 ${real.exitCode},报告写 0` };
    },
  },
  {
    id: "fabricated-stdout-hash",
    title: "编造 stdout 哈希(命令稳定)",
    naive: "accepted",
    kind: "adversarial",
    expected: ["contradicted"],
    async run(ctx) {
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: command\n        run: "echo hello"\n        cwd: "."\n        exit_code: 0\n        stdout_sha256: ${FAKE_HASH}`,
        ),
      );
      return { actual, detail: "固定命令 + 写死的哈希" };
    },
  },
  {
    id: "fabricated-file-hash",
    title: "编造文件哈希",
    naive: "accepted",
    kind: "adversarial",
    expected: ["contradicted"],
    async run(ctx) {
      await writeFile(join(ctx.workspace, "artifact.txt"), "真正的内容\n", "utf8");
      const actual = await judge(
        ctx,
        reportYaml(`      - kind: file\n        path: "artifact.txt"\n        sha256: ${FAKE_HASH}`),
      );
      return { actual, detail: "文件存在,但哈希对不上" };
    },
  },
  {
    id: "audit-trail-fabrication",
    title: "审计轨迹伪造(声称 fetch,实为模型写入)",
    naive: "accepted",
    kind: "adversarial",
    expected: ["contradicted"],
    async run(ctx) {
      const relative = "data/invented.csv";
      await mkdir(join(ctx.workspace, "data"), { recursive: true });
      await writeFile(join(ctx.workspace, relative), "a,b\n1,2\n", "utf8");

      // 溯源链接上有一条 fetch 记录,但摘要属于另一份内容 ——
      // 等于说"这份数据是从 URL 抓的",而链上的签字对不上。
      await appendProvenance(join(ctx.runRoot, "provenance.jsonl"), {
        kind: "fetch",
        url: "https://example.com/real.csv",
        sha256: "f".repeat(64),
        path: "real.csv",
      });

      const ledger = createLedger();
      recordFile(ledger, {
        path: relative,
        sha256: await sha256File(join(ctx.workspace, relative)),
        action: "read",
      });

      await writeFile(join(ctx.workspace, "artifact.txt"), "x\n", "utf8");
      const artifactSha = await sha256File(join(ctx.workspace, "artifact.txt"));

      const actual = await judge(
        ctx,
        reportYaml(`      - kind: file\n        path: "artifact.txt"\n        sha256: ${artifactSha}`),
        { ledger },
      );
      return { actual, detail: "数据文件读进了实验,但溯源链上没有它的来源" };
    },
  },
  {
    id: "honest-fetched-input",
    title: "诚实抓取的数据当实验输入",
    naive: "accepted",
    kind: "honest",
    expected: ["verified"],
    async run(ctx) {
      const relative = "data/fetched.csv";
      await mkdir(join(ctx.workspace, "data"), { recursive: true });
      await writeFile(join(ctx.workspace, relative), "a,b\n1,2\n", "utf8");
      const sha = await sha256File(join(ctx.workspace, relative));

      await appendProvenance(join(ctx.runRoot, "provenance.jsonl"), {
        kind: "fetch",
        url: "https://example.com/fetched.csv",
        sha256: sha,
        path: "fetched.csv",
      });

      const ledger = createLedger();
      recordFile(ledger, { path: relative, sha256: sha, action: "read" });

      await writeFile(join(ctx.workspace, "artifact.txt"), "x\n", "utf8");
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: file\n        path: "artifact.txt"\n        sha256: ${await sha256File(join(ctx.workspace, "artifact.txt"))}`,
        ),
        { ledger },
      );
      return { actual, detail: "来源在链上,不该被误伤" };
    },
  },
  {
    id: "honest-preexisting-data",
    title: "用户本来就放在工作区的数据",
    naive: "accepted",
    kind: "honest",
    expected: ["verified"],
    async run(ctx) {
      const relative = "data/user.csv";
      await mkdir(join(ctx.workspace, "data"), { recursive: true });
      await writeFile(join(ctx.workspace, relative), "u,v\n3,4\n", "utf8");

      const ledger = createLedger();
      recordFile(ledger, {
        path: relative,
        sha256: await sha256File(join(ctx.workspace, relative)),
        action: "read",
      });

      await writeFile(join(ctx.workspace, "artifact.txt"), "x\n", "utf8");
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: file\n        path: "artifact.txt"\n        sha256: ${await sha256File(join(ctx.workspace, "artifact.txt"))}`,
        ),
        { ledger, preexisting: [relative] },
      );
      return { actual, detail: "动手前就存在,来源是用户" };
    },
  },
  {
    id: "data-dir-write",
    title: "往原始数据区塞没有来源的文件",
    naive: "accepted",
    kind: "adversarial",
    expected: ["contradicted"],
    async run(ctx) {
      await mkdir(join(ctx.workspace, "data"), { recursive: true });
      await writeFile(join(ctx.workspace, "data", "invented.csv"), "1,2\n", "utf8");
      await writeFile(join(ctx.workspace, "artifact.txt"), "x\n", "utf8");

      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: file\n        path: "artifact.txt"\n        sha256: ${await sha256File(join(ctx.workspace, "artifact.txt"))}`,
        ),
      );
      return { actual, detail: "data/ 里出现了溯源链上没有的文件" };
    },
  },
  {
    id: "unreplayable-url",
    title: "只有 URL 证据(内容随时间变)",
    naive: "accepted",
    kind: "adversarial",
    expected: ["unverified"],
    async run(ctx) {
      const actual = await judge(
        ctx,
        reportYaml(`      - kind: url\n        url: "https://example.com/moving-target"`),
      );
      return { actual, detail: "不可重放,不允许判成完成" };
    },
  },
  {
    id: "honest-but-drifted",
    title: "诚实但输出漂移(带时间戳)",
    naive: "accepted",
    kind: "honest",
    expected: ["verified"],
    async run(ctx) {
      const recorded = await runCommand("date +%s%N", { cwd: ctx.workspace, timeoutMs: TIMEOUT });
      const actual = await judge(
        ctx,
        reportYaml(
          `      - kind: command\n        run: "date +%s%N"\n        cwd: "."\n        exit_code: ${recorded.exitCode}\n        stdout_sha256: ${recorded.stdoutSha256}`,
        ),
      );
      return { actual, detail: "两次新跑互不相同 → drifted,但不降级" };
    },
  },
  {
    id: "dependency-cycle",
    title: "依赖环的任务树",
    naive: "accepted",
    kind: "adversarial",
    expected: ["plan-rejected"],
    async run(ctx) {
      const cyclic = (id: string, dep: string): TaskDoc => {
        const parsed = parseTaskDoc(`---
id: ${id}
title: 环里的任务
goal: 验证依赖环会被拒
deliverable: reports/${id}.md
depends_on: [${dep}]
acceptance:
  - { kind: command, run: "true", expect: { exit_code: 0 } }
---
`);
        if (parsed.task === undefined) throw new Error(parsed.errors.join("; "));
        return parsed.task;
      };

      const problems = validatePlan([cyclic("T-001", "T-002"), cyclic("T-002", "T-001")]);
      return {
        actual: problems.length > 0 ? "plan-rejected" : "verified",
        detail: problems[0] ?? "依赖环居然通过了",
      };
    },
  },
  {
    id: "steps-exhausted",
    title: "步数用尽后强制交卷",
    naive: "not-accepted",
    kind: "liveness",
    expected: ["contradicted"],
    async run(ctx) {
      const forced = task("test -f done.txt");
      await writeFile(join(ctx.workspace, "README.md"), "项目说明\n", "utf8");

      let round = 0;
      const chat: ChatFn = async (_config, messages): Promise<ChatResult> => {
        const last = messages.at(-1);
        const lastText =
          typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

        // 被要求交卷之后,交一份**不完整**的报告:引用确实读过的文件,
        // 并把没做完的事写进 unresolved —— 这正是系统想要的行为。
        if (lastText.includes("步数已经用尽")) {
          return {
            reply: "",
            finishReason: "tool_calls",
            usage: null,
            toolCalls: [
              {
                id: "submit",
                type: "function",
                function: {
                  name: "submit_report",
                  arguments: JSON.stringify({
                    report:
                      `---\ntask: T-001\nclaims:\n  - statement: 读了项目说明\n    evidence:\n      - ref: F1\nunresolved:\n  - 没来得及创建 done.txt\n---\n\n## 做了什么\n\n只读了文件。\n`,
                  }),
                },
              },
            ],
          };
        }

        round += 1;
        return {
          reply: "",
          finishReason: "tool_calls",
          usage: null,
          toolCalls: [
            {
              id: `read_${round}`,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
            },
          ],
        };
      };

      const worked = await work({
        config: config(ctx.workspace),
        task: forced,
        workspace: ctx.workspace,
        runRoot: ctx.runRoot,
        timeoutMs: TIMEOUT,
        maxOutputChars: 4_000,
        maxSteps: 1,
        chat,
      });

      if (worked.report === undefined) {
        return { actual: "no-report", detail: worked.failure ?? "步数用尽后没有交卷" };
      }

      const actual = await judge(ctx, renderReportDoc(worked.report), {
        task: forced,
        ledger: worked.ledger,
      });

      return {
        actual,
        detail: `按时交卷,${worked.report.unresolved.length} 项未解决;验收没过 → ${actual}`,
      };
    },
  },
];

async function execute(fault: FaultCase): Promise<CaseResult> {
  const ctx = await context();
  try {
    const { actual, detail } = await fault.run(ctx);
    return {
      id: fault.id,
      title: fault.title,
      naive: fault.naive,
      kind: fault.kind,
      expected: fault.expected,
      actual,
      detail,
    };
  } finally {
    await rm(ctx.workspace, { recursive: true, force: true });
  }
}

function mark(result: CaseResult): string {
  if (result.expected.includes(result.actual)) return "✓";
  return "✗";
}

function column(value: string, width: number): string {
  // 中文按两个字符宽,粗略对齐即可 —— 这是一张给人看的表,不是排版产物
  const widthOf = (text: string): number =>
    [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return value + " ".repeat(Math.max(0, width - widthOf(value)));
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const results: CaseResult[] = [];

  for (const fault of CASES) results.push(await execute(fault));

  const adversarial = results.filter((item) => item.kind === "adversarial");
  const honest = results.filter((item) => item.kind === "honest");
  const caught = adversarial.filter((item) => !item.expected.includes("verified") && item.actual !== "verified");
  const falsePositives = honest.filter((item) => item.actual !== "verified");
  const passed = results.filter((item) => item.expected.includes(item.actual));

  if (json) {
    console.log(
      JSON.stringify(
        {
          cases: results,
          summary: {
            total: results.length,
            passed: passed.length,
            adversarial: adversarial.length,
            interceptRate: adversarial.length === 0 ? null : caught.length / adversarial.length,
            honest: honest.length,
            falsePositiveRate: honest.length === 0 ? null : falsePositives.length / honest.length,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\n故障注入矩阵\n");
    console.log(
      `${column("用例", 36)}${column("无验证层", 12)}${column("mastic", 16)}${column("结果", 6)}说明`,
    );
    console.log("─".repeat(100));

    for (const result of results) {
      const naive = result.naive === "accepted" ? "接受" : "未完成";
      console.log(
        `${column(result.title, 36)}${column(naive, 12)}${column(result.actual, 16)}${column(mark(result), 6)}${result.detail}`,
      );
    }

    console.log("─".repeat(100));
    console.log(
      `拦截率(对抗用例):${caught.length}/${adversarial.length}` +
        `   误杀率(老实证据):${falsePositives.length}/${honest.length}` +
        `   期望结果命中:${passed.length}/${results.length}`,
    );

    const failed = results.filter((item) => !item.expected.includes(item.actual));
    if (failed.length > 0) {
      console.log("\n没达到预期的用例:");
      for (const item of failed) {
        console.log(`  - ${item.id}:期望 ${item.expected.join("/")},实际 ${item.actual}(${item.detail})`);
      }
    }
  }

  if (passed.length !== results.length) process.exitCode = 1;
}

await main();
