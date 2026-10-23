import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { DocError, parseDoc } from "./doc/frontmatter.ts";
import { resolveInside } from "./paths.ts";
import type { Tool } from "./tools/index.ts";
import { userConfigDir } from "./workspaces.ts";

/**
 * 技能 = 一份写给 worker 看的工作手册。
 *
 * 它就是一段 Markdown,外加可选的若干附件。和 MCP 的区别在于:
 * MCP 给的是**能力**(能查什么、能做什么),技能给的是**做法**(这类活该怎么干)。
 *
 * 技能不改变 mastic 的判定 —— 它只是上下文。一个技能写得再好,worker 交上来的
 * 报告照样要过验收、证据照样要重放。
 */

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  /** 同名时项目级覆盖用户级。 */
  source: "workspace" | "user";
}

export interface Skill extends SkillInfo {
  body: string;
  /** 技能目录下的其他文件,相对路径。SKILL.md 自己不在里面。 */
  files: string[];
}

const MANIFEST_LIMIT = 200;
const DIR_DEPTH_LIMIT = 4;

interface ParsedSkillFile {
  name?: string;
  description?: string;
  body: string;
}

/**
 * 解析 SKILL.md。
 *
 * frontmatter 坏了不当作致命错误 —— 一份写得像人话的手册仍然有用,
 * 只是名字退回目录名、描述退回正文第一句。
 */
function parseSkillFile(raw: string): ParsedSkillFile {
  try {
    const { data, body } = parseDoc(raw);
    const name = typeof data.name === "string" ? data.name.trim() : undefined;
    const description = typeof data.description === "string" ? data.description.trim() : undefined;
    return {
      ...(name === undefined || name === "" ? {} : { name }),
      ...(description === undefined || description === "" ? {} : { description }),
      body,
    };
  } catch (error) {
    if (!(error instanceof DocError)) throw error;
    return { body: raw };
  }
}

function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed !== "") return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  }
  return "";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverIn(root: string, source: SkillInfo["source"]): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // 目录名以点开头的是隐藏目录,不当成技能
    if (entry.name.startsWith(".")) continue;

    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue; // 没有 SKILL.md 的目录不算技能
    }

    const parsed = parseSkillFile(raw);
    skills.push({
      name: parsed.name ?? entry.name,
      description: parsed.description ?? firstLine(parsed.body),
      dir,
      source,
    });
  }

  return skills;
}

export interface DiscoverSkillsOptions {
  /** 用户级技能目录的父目录,默认 `~/.config/mastic`。测试里改它。 */
  userConfigDir?: string;
}

/**
 * 两处找技能:用户级和项目级。
 *
 * 同名时项目级赢。理由和 MCP 配置一样:用户级说"我这台机器上有什么",
 * 项目级说"这个仓库该怎么干" —— 后者更具体。
 */
export async function discoverSkills(
  workspace: string,
  options: DiscoverSkillsOptions = {},
): Promise<SkillInfo[]> {
  const userRoot = join(options.userConfigDir ?? userConfigDir(), "skills");
  const workspaceRoot = join(workspace, ".mastic", "skills");

  const user = await discoverIn(userRoot, "user");
  const project = await discoverIn(workspaceRoot, "workspace");

  const byName = new Map<string, SkillInfo>();
  for (const skill of user) byName.set(skill.name, skill);
  for (const skill of project) byName.set(skill.name, skill);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listFiles(dir: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > DIR_DEPTH_LIMIT) return [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= MANIFEST_LIMIT) break;
    if (entry.name.startsWith(".")) continue;

    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(dir, entry.name), relative, depth + 1)));
      continue;
    }

    if (relative === "SKILL.md") continue;
    files.push(relative);
  }

  return files.slice(0, MANIFEST_LIMIT);
}

export async function loadSkill(info: SkillInfo): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(join(info.dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }

  const parsed = parseSkillFile(raw);
  return {
    ...info,
    body: parsed.body.trim(),
    files: await listFiles(info.dir),
  };
}

/** 注入 worker 的那一段。 */
export function renderSkill(skill: Skill): string {
  const body = skill.body === "" ? "(这份技能只有 frontmatter,没有正文)" : skill.body;
  const manifest =
    skill.files.length === 0
      ? ""
      : `\n\n技能目录里的其他文件(用 \`read_skill_file\` 读,\`path\` 相对技能目录):\n` +
        skill.files.map((file) => `- ${file}`).join("\n");

  return `## 技能:${skill.name}\n\n${body}${manifest}`;
}

/** 读技能附件。路径被锁在那个技能的目录里 —— 技能不是通往外部的后门。 */
export function skillFileTool(skills: readonly Skill[]): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "read_skill_file",
        description:
          "读取当前任务所挂技能目录里的一个文件(脚本、参考数据、模板……)。" +
          "只能读任务书里列出的技能,路径相对技能目录。",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "技能名。" },
            path: { type: "string", description: "相对技能目录的路径。" },
          },
          required: ["skill", "path"],
        },
      },
    },

    async run(args, ctx) {
      const name = args.skill;
      const path = args.path;
      if (typeof name !== "string" || typeof path !== "string" || path.trim() === "") {
        throw new Error("`skill` 和 `path` 都必须是非空字符串");
      }

      const skill = skills.find((candidate) => candidate.name === name);
      if (skill === undefined) {
        throw new Error(`这个任务没有挂技能 \`${name}\`。可用的是:${skills.map((s) => s.name).join("、")}`);
      }

      const full = resolveInside(skill.dir, path);
      const buffer = await readFile(full);

      // 二进制文件按 utf8 读出来是一堆乱码,不如直接说清楚
      if (buffer.includes(0)) {
        throw new Error(`\`${path}\` 不是文本文件。`);
      }

      const text = buffer.toString("utf8");
      const clipped =
        text.length <= ctx.maxOutputChars
          ? text
          : `${text.slice(0, ctx.maxOutputChars)}\n…(已截断,原文 ${text.length} 字符)`;

      return `技能 ${skill.name} / ${posix.normalize(path)}\n--- 内容 ---\n${clipped}`;
    },
  };
}
