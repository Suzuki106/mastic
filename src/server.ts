import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { parseDoc } from "./doc/frontmatter.ts";
import { readEvents } from "./events.ts";
import { listRunIds, readRunDoc, runPaths, type RunPaths } from "./workspace.ts";

export interface ServerOptions {
  workspace: string;
  runId: string;
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
};

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function serveStatic(name: string): Promise<Response> {
  try {
    const content = await readFile(new URL(`./web/${name}`, import.meta.url));
    const extension = name.slice(name.lastIndexOf("."));
    return new Response(content, {
      headers: { "content-type": MIME[extension] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

/**
 * 把 events.jsonl 的新增行推给浏览器。
 *
 * 轮询文件而不是进程内事件总线:`mastic run` 和 `mastic ui` 是两个进程,
 * 一边跑一边看才是最常用的姿势,内存里那份事件流对方根本拿不到。
 */
function eventStream(paths: RunPaths): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  let timer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const push = async (): Promise<void> => {
        const events = await readEvents(paths);
        for (const event of events.slice(sent)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        sent = events.length;
      };

      void push();
      timer = setInterval(() => void push(), 500);
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

async function route(request: Request, options: ServerOptions): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/") return await serveStatic("index.html");
  if (path === "/app.js") return await serveStatic("app.js");
  if (path === "/style.css") return await serveStatic("style.css");

  if (path === "/api/runs") {
    const ids = await listRunIds(options.workspace);
    const runs = await Promise.all(
      ids.map(async (id) => {
        const doc = await readRunDoc(runPaths(options.workspace, id));
        return { id, goal: doc?.goal ?? "", status: doc?.status ?? "unknown" };
      }),
    );
    return json({ runs: runs.reverse(), active: options.runId });
  }

  const match = /^\/api\/runs\/([^/]+)(\/events)?$/.exec(path);
  if (match?.[1] !== undefined) {
    const id = decodeURIComponent(match[1]);
    if (!(await listRunIds(options.workspace)).includes(id)) {
      return new Response("no such run", { status: 404 });
    }

    const paths = runPaths(options.workspace, id);
    return match[2] === "/events" ? eventStream(paths) : json(await collectRun(paths));
  }

  return new Response("not found", { status: 404 });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const routed = await route(new Request(`http://${host}${request.url ?? "/"}`), options);
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
