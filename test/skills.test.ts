import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createLedger } from "../src/ledger.ts";
import { discoverSkills, loadSkill, renderSkill, skillFileTool } from "../src/skills.ts";
import type { ToolContext } from "../src/tools/index.ts";

const cleanup: (() => Promise<void>)[] = [];
after(async () => {
  for (const run of cleanup) await run();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastic-skill-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSkill(
  root: string,
  name: string,
  options: { frontmatter?: string; body?: string; files?: Record<string, string> } = {},
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), options.frontmatter ?? `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n${options.body ?? "怎么做。"}\n`);

  for (const [path, content] of Object.entries(options.files ?? {})) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  return dir;
}

function context(workspace: string, maxOutputChars = 10_000): ToolContext {
  return { workspace, runRoot: workspace, ledger: createLedger(), timeoutMs: 5_000, maxOutputChars };
}

describe("技能发现", () => {
  it("从 .mastic/skills 里读出名字和描述", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "paper-repro", {
      frontmatter: "---\nname: paper-repro\ndescription: 从论文里复现一张图\n---\n\n照这个做。\n",
    });

    const skills = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "paper-repro");
    assert.equal(skills[0]?.description, "从论文里复现一张图");
    assert.equal(skills[0]?.source, "workspace");
  });

  it("用户级和项目级同名时,项目级赢", async () => {
    const workspace = await tempDir();
    const userConfig = join(workspace, "user-config");
    await writeSkill(join(userConfig, "skills"), "deploy", {
      frontmatter: "---\nname: deploy\ndescription: 用户级的老办法\n---\n",
    });
    await writeSkill(join(workspace, ".mastic", "skills"), "deploy", {
      frontmatter: "---\nname: deploy\ndescription: 这个仓库的办法\n---\n",
    });

    const skills = await discoverSkills(workspace, { userConfigDir: userConfig });
    const deploy = skills.find((skill) => skill.name === "deploy");
    assert.equal(deploy?.description, "这个仓库的办法");
    assert.equal(deploy?.source, "workspace");
  });

  it("没有 SKILL.md 的目录不算技能", async () => {
    const workspace = await tempDir();
    const root = join(workspace, ".mastic", "skills");
    await mkdir(join(root, "empty"), { recursive: true });
    await writeSkill(root, "real");

    const skills = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.deepEqual(skills.map((skill) => skill.name), ["real"]);
  });

  it("frontmatter 坏了不致命,名字退回目录名", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "legacy", {
      frontmatter: "这不是 frontmatter\n\n直接就是正文。\n",
    });

    const skills = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.equal(skills[0]?.name, "legacy");
    // 没有 frontmatter 时,描述退回正文第一行
    assert.ok(skills[0]?.description.includes("这不是 frontmatter"));
  });
});

describe("技能加载与注入", () => {
  it("正文和附件清单都能拿到,SKILL.md 不在清单里", async () => {
    const workspace = await tempDir();
    const dir = await writeSkill(join(workspace, ".mastic", "skills"), "crawler", {
      body: "先登录,再抓。",
      files: { "scripts/run.sh": "echo hi\n", "notes.md": "备注\n" },
    });

    const [info] = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.ok(info !== undefined);

    const skill = await loadSkill(info);
    assert.ok(skill !== null);
    assert.equal(skill.body, "先登录,再抓。");
    assert.deepEqual([...skill.files].sort(), ["notes.md", "scripts/run.sh"]);
    assert.equal(skill.dir, dir);
  });

  it("注入文本里有正文和附件路径", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "crawler", {
      body: "先登录,再抓。",
      files: { "scripts/run.sh": "echo hi\n" },
    });

    const [info] = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.ok(info !== undefined);
    const skill = await loadSkill(info);
    assert.ok(skill !== null);

    const text = renderSkill(skill);
    assert.ok(text.includes("## 技能:crawler"));
    assert.ok(text.includes("先登录,再抓。"));
    assert.ok(text.includes("scripts/run.sh"));
  });
});

describe("read_skill_file", () => {
  it("能读技能目录里的文件", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "crawler", {
      files: { "scripts/run.sh": "echo hi\n" },
    });

    const [info] = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.ok(info !== undefined);
    const skill = await loadSkill(info);
    assert.ok(skill !== null);

    const tool = skillFileTool([skill]);
    const output = await tool.run({ skill: "crawler", path: "scripts/run.sh" }, context(workspace));
    assert.ok(typeof output === "string" && output.includes("echo hi"));
  });

  it("不能拿它当读工作区的后门", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "crawler");
    await writeFile(join(workspace, "secret.txt"), "不该被读到");

    const [info] = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.ok(info !== undefined);
    const skill = await loadSkill(info);
    assert.ok(skill !== null);

    const tool = skillFileTool([skill]);
    await assert.rejects(() => tool.run({ skill: "crawler", path: "../secret.txt" }, context(workspace)));
  });

  it("没挂在任务上的技能读不到", async () => {
    const workspace = await tempDir();
    await writeSkill(join(workspace, ".mastic", "skills"), "crawler");

    const [info] = await discoverSkills(workspace, { userConfigDir: join(workspace, "no-user") });
    assert.ok(info !== undefined);
    const skill = await loadSkill(info);
    assert.ok(skill !== null);

    const tool = skillFileTool([]);
    await assert.rejects(() => tool.run({ skill: "crawler", path: "SKILL.md" }, context(workspace)));
  });
});
