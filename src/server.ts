import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { parseDoc } from "./doc/frontmatter.ts";
import { readEvents, type RunEvent } from "./events.ts";
import { orchestrate } from "./orchestrator.ts";
import { listRunIds, newRunId, readRunDoc, runPaths, type RunPaths, type RunDoc } from "./workspace.ts";

export interface ServerOptions {
  workspace: string;
  runId?: string;
  port: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** 一次由界面发起的运行。跑完就留在表里,好让前端知道"它不在跑了"。 */
interface ActiveRun {
  runId: string;
  goal: string;
  controller: AbortController;
  startedAt: string;
  finished: boolean;
  error?: string;
}

/**
 * 文档在磁盘上是 frontmatter + 正文。前端要的是拆开的两半 ——
 * 由服务端拆好给它,浏览器里就不必再塞一个 YAML 解析器。
 */
async function readDocument(path: string): Promise<{ data: unknown; body: string } | null> {
  try {
    const parsed = parseDoc(await readFile(path, "utf8"));
    return { data: parsed.data, body: parsed.body };
  } catch {
    return null;
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function collectRun(paths: RunPaths): Promise<unknown> {
  const [taskFiles, reportFiles] = await Promise.all([
    markdownFiles(paths.tasksDir),
    markdownFiles(paths.reportsDir),
  ]);

  const readAll = (dir: string, files: string[]) =>
    Promise.all(files.map(async (file) => ({ file, doc: await readDocument(join(dir, file)) })));

  return {
    run: await readRunDoc(paths),
    tasks: await readAll(paths.tasksDir, taskFiles),
    reports: await readAll(paths.reportsDir, reportFiles),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await request.text());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ── 静态资源:web/dist ──────────────────────────────────── */

const DIST = new URL("../web/dist/", import.meta.url);

export function distDir(): URL {
  return DIST;
}

async function serveAsset(pathname: string): Promise<Response> {
  // 只允许 dist 内部的文件,挡掉 ../ 穿越
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const target = new URL(relative === "" ? "index.html" : relative, DIST);

  if (!target.href.startsWith(DIST.href)) {
    return new Response("not found", { status: 404 });
  }

  try {
    const content = await readFile(target);
    return new Response(content, {
      headers: { "content-type": MIME[extname(target.pathname)] ?? "application/octet-stream" },
    });
  } catch {
    // SPA:任何不存在的路径都回 index.html,由前端路由接手
    try {
      return new Response(await readFile(new URL("index.html", DIST)), {
        headers: { "content-type": MIME[".html"] ?? "text/html" },
      });
    } catch {
      return new Response(
        "前端还没有构建。先跑:\n\n  npm run build:web\n\n然后再起 mastic ui。\n",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
  }
}

/* ── 事件流 ─────────────────────────────────────────────── */

/**
 * 把 events.jsonl 的新增行推给浏览器。
 *
 * 轮询文件而不是进程内事件总线:`mastic run` 和 `mastic ui` 是两个进程,
 * 一边跑一边看才是最常用的姿势,内存里那份事件流对方根本拿不到。
 * 200ms 是为了让界面看着是"流"出来的,而不是一跳一跳的。
 */
function eventStream(paths: RunPaths): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  let timer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const push = async (): Promise<void> => {
        const events: RunEvent[] = await readEvents(paths);
        for (const event of events.slice(sent)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        sent = events.length;
      };

      void push();
      timer = setInterval(() => void push(), 200);
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}

/* ── 运行管理 ───────────────────────────────────────────── */

function makeRunManager(workspace: string) {
  const active = new Map<string, ActiveRun>();
  let config: Config | null = null;

  return {
    list(): ActiveRun[] {
      return [...active.values()];
    },

    isRunning(runId: string): boolean {
      const run = active.get(runId);
      return run !== undefined && !run.finished;
    },

    /** 起一次运行。立刻返回 runId,活儿在后台跑。 */
    start(goal: string): { runId: string } | { error: string } {
      // 只在真的要跑的时候才要 key —— 光看界面不需要
      try {
        config ??= loadConfig();
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }

      const runId = newRunId();
      const controller = new AbortController();
      const entry: ActiveRun = {
        runId,
        goal,
        controller,
        startedAt: new Date().toISOString(),
        finished: false,
      };
      active.set(runId, entry);

      void orchestrate({
        config,
        goal,
        workspace,
        runId,
        signal: controller.signal,
      })
        .then((result) => {
          entry.finished = true;
          if (result.failure !== undefined) entry.error = result.failure;
        })
        .catch((error: unknown) => {
          entry.finished = true;
          entry.error = error instanceof Error ? error.message : String(error);
        });

      return { runId };
    },

    cancel(runId: string): boolean {
      const run = active.get(runId);
      if (run === undefined || run.finished) return false;
      run.controller.abort();
      return true;
    },
  };
}

/* ── 路由 ───────────────────────────────────────────────── */

async function route(
  request: Request,
  options: ServerOptions,
  runs: ReturnType<typeof makeRunManager>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    if (path === "/api/runs" && request.method === "POST") {
      const body = await readJsonBody(request);
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      if (goal === "") return json({ error: "要跑什么?goal 不能为空。" }, 400);

      const result = runs.start(goal);
      if ("error" in result) return json(result, 400);
      return json(result, 201);
    }

    if (path === "/api/runs") {
      const ids = await listRunIds(options.workspace);
      const docs = await Promise.all(
        ids.map(async (id) => {
          const doc: RunDoc | undefined = await readRunDoc(runPaths(options.workspace, id));
          return {
            id,
            goal: doc?.goal ?? "",
            status: doc?.status ?? "unknown",
            running: runs.isRunning(id),
          };
        }),
      );
      return json({ runs: docs.reverse() });
    }

    const match = /^\/api\/runs\/([^/]+)(\/events|\/cancel)?$/.exec(path);
    if (match?.[1] !== undefined) {
      const id = decodeURIComponent(match[1]);
      const known = runs.list().some((entry) => entry.runId === id);
      if (!known && !(await listRunIds(options.workspace)).includes(id)) {
        return json({ error: "没有这次运行" }, 404);
      }

      const paths = runPaths(options.workspace, id);

      if (match[2] === "/events") return eventStream(paths);
      if (match[2] === "/cancel") {
        if (request.method !== "POST") return json({ error: "用 POST" }, 405);
        return json({ cancelled: runs.cancel(id) });
      }

      const payload = (await collectRun(paths)) as Record<string, unknown>;
      return json({ ...payload, running: runs.isRunning(id) });
    }

    return json({ error: "没有这个接口" }, 404);
  }

  return await serveAsset(path);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const runs = makeRunManager(options.workspace);

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        // 方法和 body 都得手工搬过去 —— 只给 URL 的话 Request 默认是 GET,
        // POST /api/runs 会静默地落到"列运行"那个分支上,看着像没反应。
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        const rawBody = Buffer.concat(chunks);

        const method = request.method ?? "GET";
        const hasBody = method !== "GET" && method !== "HEAD" && rawBody.length > 0;

        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(", "));
        }

        const routed = await route(
          new Request(`http://${host}${request.url ?? "/"}`, {
            method,
            headers,
            ...(hasBody ? { body: rawBody } : {}),
          }),
          options,
          runs,
        );
        response.writeHead(routed.status, Object.fromEntries(routed.headers));

        if (routed.body === null) {
          response.end();
          return;
        }

        // 逐块转发而不是 arrayBuffer() —— 事件流是无限长的,
        // 攒完再发就等于永远不发。
        const reader = routed.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(Buffer.from(value));
        }
        response.end();
      } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end("internal error");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
