import type { Config } from "./config.ts";
import { connectMcp } from "./mcp/index.ts";
import { discoverSkills, type SkillInfo } from "./skills.ts";
import type { Tool } from "./tools/index.ts";

/**
 * 一次运行可以带上的两样外挂:**MCP 工具**和**技能**。
 *
 * 两者都在运行开始时加载、运行结束时关掉。MCP 服务是外部进程,漏关就是漏关 ——
 * 所以它的生命周期被钉在这一个对象上,调用方只需要在 finally 里 close 一次。
 *
 * 加载失败不致命:一个配错的 MCP 服务不该把整次运行挡住,它会被记成一条事件。
 */
export interface Extensions {
  /** MCP 服务提供的工具。planner 拿不到它们,只有 worker 能调。 */
  mcpTools: readonly Tool[];
  /** 技能索引(名字 + 描述 + 目录)。正文由 worker 按任务书里的 `skills` 去读。 */
  skills: readonly SkillInfo[];
  close(): void;
}

export interface LoadExtensionsOptions {
  config: Config;
  workspace: string;
  /** 用户级配置目录,默认 `~/.config/mastic`。测试里改它,免得读到本机配置。 */
  userConfigDir?: string;
  onEvent?: (detail: string) => void;
}

const EMPTY: Extensions = { mcpTools: [], skills: [], close() {} };

export async function loadExtensions(options: LoadExtensionsOptions): Promise<Extensions> {
  if (!options.config.mcp && !options.config.skills) return EMPTY;

  let mcpTools: readonly Tool[] = [];
  let servers: string[] = [];
  let close = (): void => {};

  if (options.config.mcp) {
    try {
      const connected = await connectMcp({
        workspace: options.workspace,
        ...(options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir }),
      });
      mcpTools = connected.tools;
      servers = connected.servers;

      for (const problem of connected.problems) options.onEvent?.(problem);

      if (connected.tools.length > 0) {
        options.onEvent?.(
          `MCP:${servers.length} 个服务,${connected.tools.length} 个工具(${servers.join("、")})`,
        );
      }
      close = () => connected.close();
    } catch (error) {
      options.onEvent?.(`MCP 没能加载:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let skills: readonly SkillInfo[] = [];
  if (options.config.skills) {
    try {
      skills = await discoverSkills(options.workspace, {
        ...(options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir }),
      });
      if (skills.length > 0) {
        options.onEvent?.(`技能 ${skills.length} 个:${skills.map((skill) => skill.name).join("、")}`);
      }
    } catch (error) {
      options.onEvent?.(`技能没能加载:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { mcpTools, skills, close };
}
