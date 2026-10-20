import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES, parseDataUrl, type IncomingImage } from "./attachments.ts";
import { loadConfig, visionEnabled, type Config } from "./config.ts";
import { parseDoc } from "./doc/frontmatter.ts";
import { readEvents, type RunEvent } from "./events.ts";
import { orchestrate } from "./orchestrator.ts";
import { resolveInside } from "./paths.ts";
import { continueRun } from "./resume.ts";
import { listRunIds, newRunId, readRunDoc, runPaths, type RunPaths, type RunDoc } from "./workspace.ts";
import { loadWorkspaceRegistry, type WorkspaceRegistry } from "./workspaces.ts";

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
  // 附图要能被浏览器直接画出来,类型得说对
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 一次由界面发起的运行。跑完就留在表里,好让前端知道"它不在跑了"。 */
interface ActiveRun {
  runId: string;
  goal: string;
  controller: AbortController;
  startedAt: string;
  finished: boolean;
  error?: string;
  /**
   * 这次运行到目前为止的全部事件,含**不落盘**的推理摘录。
   *
   * 活跃的运行直接从这份内存流给界面 —— 读文件的话,那些只该实时看的
   * 东西就看不到了。
   */
  live: RunEvent[];
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

/**
 * 校验并收敛请求里的图片。
 *
 * 在这里就拦掉 —— 等运行起来了才发现图是坏的,用户已经白等一场。
 */
function readImages(raw: unknown): { images: IncomingImage[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_IMAGES) return { error: `最多带 ${MAX_IMAGES} 张图。` };

  const images: IncomingImage[] = [];
  let totalBytes = 0;
  for (const [index, item] of list.entries()) {
    if (typeof item !== "object" || item === null) {
      return { error: `第 ${index + 1} 张图格式不对。` };
    }
    const { dataUrl, name } = item as { dataUrl?: unknown; name?: unknown };
    if (typeof dataUrl !== "string") {
      return { error: `第 ${index + 1} 张图缺 dataUrl。` };
    }
    const parsed = parseDataUrl(dataUrl);
    if ("error" in parsed) {
      return { error: `第 ${index + 1} 张图:${parsed.error}` };
    }
    totalBytes += parsed.bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { error: `这些图加起来超过 ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024}MB 了,分批发吧。` };
    }

    images.push({ dataUrl, ...(typeof name === "string" ? { name } : {}) });
  }

  return { images };
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
/**
 * 正在跑的那次:直接推内存里的事件,包括不进日志的推理摘录。
 *
 * 跑完就断开,浏览器会重连 —— 那时走文件那条路,靠 seq 去重不会重复。
 * 这是对的:推理摘录本来就是**当时**才有意义的东西。
 */
function liveEventStream(run: ActiveRun): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  let timer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const push = (): void => {
        for (const event of run.live.slice(sent)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        sent = run.live.length;
      };

      push();
      timer = setInterval(() => {
        push();
        if (run.finished) {
          if (timer !== undefined) clearInterval(timer);
          controller.close();
        }
      }, 200);
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}

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

function makeRunManager(workspaces: WorkspaceRegistry) {
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

    /** 这个进程里正跑着的那次 —— 有它就能推内存里的实时流。 */
    activeRun(runId: string): ActiveRun | undefined {
      const run = active.get(runId);
      return run !== undefined && !run.finished ? run : undefined;
    },

    /** 起一次运行。立刻返回 runId,活儿在后台跑。 */
    start(goal: string, images: IncomingImage[] = []): { runId: string } | { error: string } {
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
        live: [],
      };
      active.set(runId, entry);

      void orchestrate({
        config,
        goal,
        // 起跑那一刻的工作区。中途切走不影响这一趟 —— 它已经在那个目录里干活了。
        workspace: workspaces.current(),
        runId,
        signal: controller.signal,
        ...(images.length === 0 ? {} : { images }),
        onEvent: (event) => entry.live.push(event),
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

    /**
     * 往已有任务树上追加并执行。
     *
     * 复用同一个 runId —— 这是"接着说",不是"另起一次"。跑完的旧任务原样留着,
     * 新的追加在后面。
     */
    continueRun(runId: string, goal: string, images: IncomingImage[]): { ok: true } | { error: string } {
      const current = active.get(runId);
      if (current !== undefined && !current.finished) {
        return { error: "这次运行还在跑,等它结束或者先取消。" };
      }

      try {
        config ??= loadConfig();
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }

      const controller = new AbortController();
      const entry: ActiveRun = {
        runId,
        goal,
        controller,
        startedAt: new Date().toISOString(),
        finished: false,
        live: [],
      };
      active.set(runId, entry);

      void continueRun(config, workspaces.current(), runId, goal, images, (event) => entry.live.push(event))
        .then((result) => {
          entry.finished = true;
          if (result.nothingToDo) entry.error = "planner 认为现状已经满足,没有新增任务。";
        })
        .catch((error: unknown) => {
          entry.finished = true;
          entry.error = error instanceof Error ? error.message : String(error);
        });

      return { ok: true };
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
  workspaces: WorkspaceRegistry,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    if (path === "/api/workspaces") {
      return json({ current: workspaces.current(), known: workspaces.list() });
    }

    if (path === "/api/workspace" && request.method === "POST") {
      const body = await readJsonBody(request);
      const target = typeof body.path === "string" ? body.path : "";
      const result = await workspaces.switchTo(target);
      return result.ok ? json(result) : json(result, 400);
    }

    if (path === "/api/runs" && request.method === "POST") {
      const body = await readJsonBody(request);
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      if (goal === "") return json({ error: "要跑什么?goal 不能为空。" }, 400);

      const images = readImages(body.images);
      if ("error" in images) return json(images, 400);

      const result = runs.start(goal, images.images);
      if ("error" in result) return json(result, 400);
      return json(result, 201);
    }

    if (path === "/api/runs") {
      const workspace = workspaces.current();
      const ids = await listRunIds(workspace);
      const docs = await Promise.all(
        ids.map(async (id) => {
          const doc: RunDoc | undefined = await readRunDoc(runPaths(workspace, id));
          const entry = runs.list().find((item) => item.runId === id);
          return {
            id,
            goal: doc?.goal ?? "",
            status: doc?.status ?? "unknown",
            running: runs.isRunning(id),
            // 出错死在半路的,把原因带出去 —— 否则界面上只看到它"不在跑",
            // 不知道为什么,也不知道该不该重跑
            ...(entry?.error === undefined ? {} : { error: entry.error }),
          };
        }),
      );
      // 工作区一并带回去:界面上得能看见"活儿到底在哪个目录里干",
      // 否则用户没法知道新文件会落在哪。
      // 顺带把"这个模型收不收图"告诉界面 —— 不收就别显示上传按钮
      return json({ runs: docs.reverse(), workspace, vision: visionEnabled() });
    }

    // 附图要能被界面显示出来 —— "当时那张图长什么样"是任务书的一部分
    const attach = /^\/api\/runs\/([^/]+)\/attachments\/(.+)$/.exec(path);
    if (attach?.[1] !== undefined && attach[2] !== undefined) {
      try {
        const root = runPaths(workspaces.current(), decodeURIComponent(attach[1])).root;
        const file = resolveInside(root, join("attachments", decodeURIComponent(attach[2])));
        return new Response(await readFile(file), {
          headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    const match = /^\/api\/runs\/([^/]+)(\/events|\/cancel|\/continue)?$/.exec(path);
    if (match?.[1] !== undefined) {
      const id = decodeURIComponent(match[1]);
      const workspace = workspaces.current();
      const known = runs.list().some((entry) => entry.runId === id);
      if (!known && !(await listRunIds(workspace)).includes(id)) {
        return json({ error: "没有这次运行" }, 404);
      }

      const paths = runPaths(workspace, id);

      if (match[2] === "/events") {
        // 正在这个进程里跑 → 内存流(含实时推理);否则读文件(已落盘的记录)
        const running = runs.activeRun(id);
        return running === undefined ? eventStream(paths) : liveEventStream(running);
      }
      if (match[2] === "/cancel") {
        if (request.method !== "POST") return json({ error: "用 POST" }, 405);
        return json({ cancelled: runs.cancel(id) });
      }

      if (match[2] === "/continue") {
        if (request.method !== "POST") return json({ error: "用 POST" }, 405);

        const body = await readJsonBody(request);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (goal === "") return json({ error: "要接着做什么?goal 不能为空。" }, 400);

        const images = readImages(body.images);
        if ("error" in images) return json(images, 400);

        const result = runs.continueRun(id, goal, images.images);
        return "error" in result ? json(result, 400) : json(result, 202);
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
  const workspaces = await loadWorkspaceRegistry(options.workspace);
  const runs = makeRunManager(workspaces);

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
          workspaces,
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
