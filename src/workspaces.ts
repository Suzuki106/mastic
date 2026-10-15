import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 界面能切的工作区。
 *
 * 一次运行是**属于某个工作区的** —— 报告里的相对路径、引用的文件、下次会改的
 * 东西,都只在那个目录里说得通。所以"把所有运行混成一个列表"是错的:
 * 切过去看到的报告会和顶栏写着的工作区对不上。
 *
 * 正确的做法是让工作区本身可切。切了之后运行列表跟着换,一切都还自洽。
 */
export interface WorkspaceRegistry {
  current(): string;
  list(): string[];
  switchTo(target: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
}

/** 最近用过的记在用户配置目录里,和仓库无关。 */
export function defaultStorePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "mastic", "workspaces.json");
}

/** 只留最近这些个,免得这份文件无限长。 */
const REMEMBER = 12;

function expand(target: string): string {
  return resolve(target.replace(/^~(?=$|\/)/, homedir()));
}

async function readStore(storePath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function writeStore(storePath: string, paths: string[]): Promise<void> {
  try {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(paths, null, 2)}\n`, "utf8");
  } catch {
    // 记不住不该让界面用不了 —— 顶多下次重启要重新点一遍
  }
}

export async function loadWorkspaceRegistry(
  initial: string,
  storePath: string = defaultStorePath(),
): Promise<WorkspaceRegistry> {
  let current = expand(initial);

  // 最近用过的排前面;当前这个永远在第一个
  const known: string[] = [];
  const remember = (path: string): void => {
    const at = known.indexOf(path);
    if (at !== -1) known.splice(at, 1);
    known.unshift(path);
    known.splice(REMEMBER);
  };

  remember(current);
  for (const path of await readStore(storePath)) remember(expand(path));

  return {
    current: () => current,
    list: () => [...known],

    async switchTo(target) {
      const path = expand(target.trim());
      if (target.trim() === "") return { ok: false, error: "路径不能为空。" };

      try {
        if (!(await stat(path)).isDirectory()) return { ok: false, error: `\`${path}\` 不是目录。` };
      } catch {
        return { ok: false, error: `\`${path}\` 不存在。` };
      }

      current = path;
      remember(path);
      await writeStore(storePath, known);

      return { ok: true, path };
    },
  };
}
