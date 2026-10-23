import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ContentPart } from "../llm.ts";
import type { Tool } from "../tools/index.ts";
import { userConfigDir } from "../workspaces.ts";
import { McpClient, type McpCallResult, type McpContentBlock, type McpServerConfig } from "./client.ts";

export type { McpServerConfig } from "./client.ts";

/**
 * MCP 服务是**外部进程**,不是 mastic 的一部分。
 *
 * 它们能读到的东西、能写的东西,都不受 mastic 的约束 —— 一个给了写权限的
 * MCP 服务可以绕过 `data/` 只读、绕过 `write_file` 的禁写规则。所以这里
 * 只负责连和转发:**信任边界在配置里,由人划定**。
 */

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
  /** 配置文件的问题。只有配置本身坏了才会有 —— 单个服务连不上不在这儿。 */
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServer(name: string, raw: unknown, where: string, problems: string[]): McpServerConfig | null {
  if (!isRecord(raw)) {
    problems.push(`${where} 里 \`${name}\` 不是对象`);
    return null;
  }
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    problems.push(`${where} 里 \`${name}\` 缺 \`command\``);
    return null;
  }

  const config: McpServerConfig = { command: raw.command };
  if (raw.disabled === true) config.disabled = true;

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string")) {
      problems.push(`${where} 里 \`${name}.args\` 必须是字符串数组`);
    } else {
      config.args = raw.args as string[];
    }
  }

  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      problems.push(`${where} 里 \`${name}.env\` 必须是 key: value 块`);
    } else {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === "string") env[key] = value;
        else problems.push(`${where} 里 \`${name}.env.${key}\` 必须是字符串`);
      }
      config.env = env;
    }
  }

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string") problems.push(`${where} 里 \`${name}.cwd\` 必须是字符串`);
    else config.cwd = raw.cwd;
  }

  return config;
}

async function readConfigFile(
  path: string,
  problems: string[],
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {}; // 没有这个文件是最常见的情况
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    problems.push(`${path} 不是合法 JSON:${detail}`);
    return {};
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    problems.push(`${path} 里没有 \`mcpServers\` 块`);
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    const config = parseServer(name, raw, path, problems);
    if (config !== null) servers[name] = config;
  }
  return servers;
}

/**
 * 用户级配置和项目级配置合起来,同名时项目级覆盖用户级。
 *
 * 合并而不是二选一,是因为这两种配置回答的是不同的问题:
 * 用户级说"我这台机器上装了哪些服务",项目级说"这个仓库要用哪些"。
 */
export async function loadMcpConfig(
  workspace: string,
  options: { userConfigDir?: string } = {},
): Promise<LoadedMcpConfig> {
  const problems: string[] = [];
  const user = await readConfigFile(
    join(options.userConfigDir ?? userConfigDir(), "mcp.json"),
    problems,
  );
  const project = await readConfigFile(join(workspace, ".mastic", "mcp.json"), problems);

  return { servers: { ...user, ...project }, problems };
}

/** 压成 OpenAI 工具名能接受的样子,并加上服务名前缀防止重名。 */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function imageUrl(block: McpContentBlock): string | null {
  if (block.data !== undefined && block.mimeType !== undefined) {
    return `data:${block.mimeType};base64,${block.data}`;
  }
  const resource = block.resource;
  if (resource?.blob !== undefined && resource.mimeType !== undefined) {
    return `data:${resource.mimeType};base64,${resource.blob}`;
  }
  return null;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(已截断,原文 ${text.length} 字符)`;
}

/**
 * 把 MCP 的 content 数组变成工具返回。
 *
 * 有图就返回内容块 —— 和 `read_image` 走同一条路,模型能看到图。
 * 没有图就给纯文本,省掉一层包装。
 */
export function renderMcpResult(result: McpCallResult, limit: number): string | ContentPart[] {
  const texts: string[] = [];
  const images: ContentPart[] = [];

  for (const block of result.content) {
    if (block.type === "text") {
      if (block.text !== undefined) texts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      const url = imageUrl(block);
      if (url !== null) images.push({ type: "image_url", image_url: { url } });
      else texts.push("[一张图,但服务没给 data 或 mimeType]");
      continue;
    }

    if (block.type === "resource") {
      const resource = block.resource;
      const uri = resource?.uri ?? "(没有 uri)";
      const url = imageUrl(block);
      if (url !== null) {
        images.push({ type: "image_url", image_url: { url } });
      } else if (resource?.text !== undefined) {
        texts.push(`[资源 ${uri}]\n${resource.text}`);
      } else {
        texts.push(`[资源 ${uri},内容不是文本]`);
      }
      continue;
    }

    texts.push(`[${block.type} 类型的返回,mastic 不解析]`);
  }

  const body = result.isError === true ? `错误:${texts.join("\n")}` : texts.join("\n");
  const text = clip(body === "" ? "(没有返回内容)" : body, limit);

  if (images.length === 0) return text;
  return [{ type: "text", text }, ...images];
}

/**
 * 有的服务给的 inputSchema 缺 `type`,有的干脆是空的。
 * OpenAI 兼容接口对此很挑,补成最小可用的对象 schema —— 不要因为服务端偷懒就调不了工具。
 */
function normalizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = schema === undefined ? {} : schema;
  const normalized: Record<string, unknown> =
    typeof base.type === "string" ? { ...base } : { type: "object", ...base };

  if (normalized.type === "object" && normalized.properties === undefined) {
    normalized.properties = {};
  }
  return normalized;
}

function wrapTool(
  server: string,
  definition: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  client: McpClient,
  name: string,
): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description: `[MCP ${server}] ${definition.description ?? definition.name}`,
        parameters: normalizeSchema(definition.inputSchema),
      },
    },

    async run(args, ctx) {
      const result = await client.callTool(definition.name, args);
      return renderMcpResult(result, ctx.maxOutputChars);
    },
  };
}

export interface ConnectedMcp {
  tools: Tool[];
  /** 连上了的服务名。 */
  servers: string[];
  /** 没连上的服务,以及为什么不致命。 */
  problems: string[];
  close(): void;
}

export interface ConnectMcpOptions {
  workspace: string;
  /** 显式给服务表;不给就去读配置文件。测试用这个。 */
  servers?: Record<string, McpServerConfig>;
  userConfigDir?: string;
  requestTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * 连上所有启用的 MCP 服务。
 *
 * 单个服务连不上**不让整次运行失败** —— 一个配错的第三方服务不该把
 * 手头能干的活全挡住。它会被记进 problems,由调用方显示出来。
 */
export async function connectMcp(options: ConnectMcpOptions): Promise<ConnectedMcp> {
  const loaded =
    options.servers === undefined
      ? await loadMcpConfig(options.workspace, {
          ...(options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir }),
        })
      : { servers: options.servers, problems: [] as string[] };

  const problems = [...loaded.problems];
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  const servers: string[] = [];
  const usedNames = new Set<string>();

  const entries = Object.entries(loaded.servers).filter(([, config]) => config.disabled !== true);

  const settled = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      const cwd =
        config.cwd === undefined
          ? undefined
          : isAbsolute(config.cwd)
            ? config.cwd
            : resolve(options.workspace, config.cwd);

      const client = new McpClient(
        name,
        cwd === undefined ? config : { ...config, cwd },
        {
          ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
        },
      );

      try {
        await client.initialize();
        const definitions = await client.listTools();
        return { name, client, definitions };
      } catch (error) {
        client.close();
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      problems.push(
        `MCP 服务没连上 —— ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      continue;
    }

    const { name, client, definitions } = result.value;
    clients.push(client);
    servers.push(name);

    for (const definition of definitions) {
      let toolName = mcpToolName(name, definition.name);
      // 两个服务里有同名工具时,后面的加序号,而不是把前一个覆盖掉
      if (usedNames.has(toolName)) {
        let suffix = 2;
        while (usedNames.has(`${toolName.slice(0, 60)}_${suffix}`)) suffix += 1;
        toolName = `${toolName.slice(0, 60)}_${suffix}`;
      }
      usedNames.add(toolName);
      tools.push(wrapTool(name, definition, client, toolName));
    }

    if (definitions.length === 0) problems.push(`MCP 服务 ${name} 连上了,但没提供任何工具。`);
  }

  return {
    tools,
    servers,
    problems,
    close() {
      for (const client of clients) client.close();
    },
  };
}
