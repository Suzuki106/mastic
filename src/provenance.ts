import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";

/**
 * 数据溯源链。
 *
 * 这个项目对"数据哪来的"要求是极端的:**实验输入只能来自外部获取或用户提供,
 * 不接受任何由模型生成的数据**。模型特别爱用 `randn` 造一份"看起来像那么回事"
 * 的数据把实验跑通 —— 那等于实验什么都没测。
 *
 * 这里能做到的和做不到的,必须说清楚:
 *
 * - **能做到**:证明一份数据确实来自某个外部地址、而且没被改过;
 *   证明这份记录本身没被事后篡改。
 * - **做不到**:证明那个外部地址上的东西是"真实世界的观测"。上游本身可能
 *   就是合成的。这条链管的是来源,不是真伪。
 *
 * 每条的摘要里含**前一条的摘要**,所以改第 5 条会让 6..n 全部对不上。
 * 这叫**篡改可检测**,不叫篡改不可能 —— 谁有磁盘写权限谁就能整条重算。
 * 我不想把这个说成比它实际更强的东西。
 */

/**
 * - `fetch`   从外部地址抓来的
 * - `user`    用户提供的(上传的图、贴的文件)
 * - `derived` 实验**产出**的数据 —— 由哪个任务、跑过哪些命令产生的
 * - `search`  搜过什么(是"发现"不是数据,但让来路可查)
 * - `note`    其它需要留痕的事
 *
 * `derived` 是给产出签的字。光给输入签字不够:一份实验结果也要能被指认
 * "它是哪个任务、用哪些命令、从哪些输入算出来的",否则产出就是一堆
 * 没有出处的数字。
 */
export type ProvenanceKind = "fetch" | "user" | "derived" | "search" | "note";

export interface ProvenanceEntry {
  /** 从 1 开始,连续。 */
  seq: number;
  at: string;
  kind: ProvenanceKind;

  /** kind = fetch */
  url?: string;
  /** 跟随重定向之后的地址。和 url 不同就说明被跳转过,这本身是信息。 */
  finalUrl?: string;
  status?: number;
  contentType?: string;
  sha256?: string;
  bytes?: number;
  /** 落盘位置,相对 run 目录。 */
  path?: string;

  /** kind = search */
  query?: string;
  resultCount?: number;

  /** kind = derived:哪个任务产出的。 */
  task?: string;
  /** kind = derived:这个任务跑过的命令编号(台账里的 C 号)。 */
  commands?: string[];

  /** kind = note */
  note?: string;

  /** 前一条的摘要;第一条是 "genesis"。 */
  prev: string;
  /** 本条(含 prev)的摘要。 */
  digest: string;
}

export const GENESIS = "genesis";

/** 键排序后序列化 —— 不排序的话,同样的内容会因为键序不同算出不同摘要。 */
function canonical(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(value, keys);
}

export function computeDigest(entry: Omit<ProvenanceEntry, "digest">): string {
  return createHash("sha256").update(canonical(entry as unknown as Record<string, unknown>)).digest("hex");
}

export async function readProvenance(path: string): Promise<ProvenanceEntry[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ProvenanceEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * 往链上追加一条。
 *
 * 读回整条链来取 prev —— 而不是在内存里记一个游标 —— 因为 worker 和
 * verifier 是分开跑的,内存里的游标活不过一次重启。
 */
export async function appendProvenance(
  path: string,
  entry: Omit<ProvenanceEntry, "seq" | "at" | "prev" | "digest">,
): Promise<ProvenanceEntry> {
  const existing = await readProvenance(path);
  const prev = existing.at(-1)?.digest ?? GENESIS;

  const withoutDigest: Omit<ProvenanceEntry, "digest"> = {
    seq: existing.length + 1,
    at: new Date().toISOString(),
    ...entry,
    prev,
  };

  const full: ProvenanceEntry = { ...withoutDigest, digest: computeDigest(withoutDigest) };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");

  return full;
}

export interface ChainCheck {
  ok: boolean;
  length: number;
  /** 第一处对不上的位置。 */
  brokenAt?: number;
  reason?: string;
}

/** 校验整条链:每条的摘要对不对、prev 有没有接上、序号连不连续。 */
export function verifyChain(entries: ProvenanceEntry[]): ChainCheck {
  let prev = GENESIS;

  for (const [index, entry] of entries.entries()) {
    const { digest, ...rest } = entry;

    if (entry.seq !== index + 1) {
      return { ok: false, length: entries.length, brokenAt: index + 1, reason: `第 ${index + 1} 条的序号是 ${entry.seq}` };
    }
    if (entry.prev !== prev) {
      return { ok: false, length: entries.length, brokenAt: index + 1, reason: `第 ${index + 1} 条的 prev 和上一条对不上` };
    }
    if (computeDigest(rest) !== digest) {
      return { ok: false, length: entries.length, brokenAt: index + 1, reason: `第 ${index + 1} 条的内容和它自己的摘要对不上` };
    }

    prev = digest;
  }

  return { ok: true, length: entries.length };
}

/**
 * 可以当实验输入的来源。
 *
 * - `fetched` 外部抓来的
 * - `user`    用户提供的
 * - `produced` 前面某个任务产出的(链上有签字:哪个任务、哪些命令)
 *
 * 前两种是**源头**;`produced` 不是源头,但它是链条中间的一环 —— 一份由
 * T-003 算出来并签了字的结果,下游任务当然可以用。真正的源头在更上游。
 */
export type TraceHow = "fetched" | "user" | "produced";

export interface TraceResult {
  traceable: boolean;
  how?: TraceHow;
  detail: string;
}

/**
 * 一份文件能不能当实验输入。
 *
 * 判据只有一条:**它的内容摘要出现在溯源链里,而且那条记录的来源是
 * fetch 或 user**。
 *
 * 走不回去的说明什么?说明这份数据是模型自己写出来的 —— `write_file` 写的东西
 * 内容来自模型,它不经过任何外部地址。这正是要拦的情况:拿模型编的数据跑实验,
 * 实验等于什么都没有测。
 *
 * 注意这条判据管的是**来源**,不是真伪:一份从 URL 抓来的数据集,它自己也可能
 * 是别人合成的。这条链保证"确实来自那个地址且没被改过",不保证那个地址上的
 * 东西是真实观测。
 */
export async function traceInput(
  provenancePath: string,
  filePath: string,
): Promise<TraceResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return { traceable: false, detail: `读不到 ${filePath}` };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const entries = await readProvenance(provenancePath);
  const hit = entries.find((entry) => entry.sha256 === sha256);

  if (hit?.kind === "fetch") {
    return { traceable: true, how: "fetched", detail: `来自 ${hit.url ?? "?"}(溯源 #${hit.seq})` };
  }
  if (hit?.kind === "user") {
    return { traceable: true, how: "user", detail: `用户提供(溯源 #${hit.seq})` };
  }
  if (hit?.kind === "derived") {
    return {
      traceable: true,
      how: "produced",
      detail: `${hit.task ?? "?"} 产出的(溯源 #${hit.seq},用了 ${hit.commands?.join("、") ?? "无"} 号命令)`,
    };
  }

  return {
    traceable: false,
    detail:
      `这份数据在溯源链里找不到来源(sha256 ${sha256.slice(0, 16)}…)。` +
      `它多半是模型自己写出来或算出来的 —— 不能当实验输入。` +
      `要么用 fetch_url 从外部抓,要么让用户提供。`,
  };
}

export interface OutputRecord {
  /** 相对 run 目录或工作目录,调用方自己定,原样记下。 */
  path: string;
  sha256: string;
  bytes?: number;
}

/**
 * 给这次任务**产出的数据**签字。
 *
 * 记的是三件事:产出了什么(路径 + 摘要)、谁产的(任务号)、怎么产的(跑过的命令)。
 * 这样一份结果文件不再是一堆没有出处的数字 —— 顺着链能回到是哪个任务、
 * 用了哪些命令、再往前是哪些输入。
 *
 * 非数据文件(源码、测试)不签 —— 那是代码不是实验数据,签了只会把链淹掉。
 */
export async function signOutputs(
  provenancePath: string,
  taskId: string,
  outputs: OutputRecord[],
  commands: string[],
): Promise<ProvenanceEntry[]> {
  const signed: ProvenanceEntry[] = [];

  for (const output of outputs) {
    signed.push(
      await appendProvenance(provenancePath, {
        kind: "derived",
        path: output.path,
        sha256: output.sha256,
        ...(output.bytes === undefined ? {} : { bytes: output.bytes }),
        task: taskId,
        commands,
      }),
    );
  }

  return signed;
}

/**
 * 什么算"数据文件"。
 *
 * 只有这些进溯源判定 —— 源码、测试、配置不算实验数据,拉进来只会把链淹掉,
 * 而且会误伤(.json 当配置用时不该被要求证明来源)。
 */
export const DATA_EXTENSIONS = [
  ".csv", ".tsv", ".jsonl", ".parquet", ".xlsx", ".npz", ".npy", ".h5", ".arrow",
  // 图片同样是"数据":AI 生成一张噪声图当输入,和编一份 CSV 是一回事
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
];

export function looksLikeDataFile(path: string): boolean {
  return DATA_EXTENSIONS.includes(extname(path).toLowerCase());
}

/** 扫的时候跳过的目录 —— 那里面的"数据"不是实验数据。 */
const SKIP_DIRS = new Set([".git", "node_modules", ".mastic", "dist", "build", "__pycache__", ".venv", "venv"]);

/**
 * 给工作区里的数据文件拍一张快照(路径 → 摘要)。
 *
 * 任务开始前拍一张、结束后拍一张,**差集就是这次产出的数据**。这样不需要
 * worker 声明产出了什么 —— 它要是不声明,产出就没人签;而"忘了声明"是最容易
 * 发生也最不该发生的事。机器自己看得见的东西,就别去问模型。
 */
export async function snapshotDataFiles(
  root: string,
  limits: { files?: number; bytes?: number } = {},
): Promise<Map<string, string>> {
  const maxFiles = limits.files ?? 2000;
  const maxBytes = limits.bytes ?? 64 * 1024 * 1024;

  const found = new Map<string, string>();
  let totalBytes = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (found.size >= maxFiles || totalBytes >= maxBytes) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.size >= maxFiles || totalBytes >= maxBytes) return;

      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), relative);
        continue;
      }

      if (!entry.isFile() || !looksLikeDataFile(entry.name)) continue;

      try {
        const content = await readFile(join(dir, entry.name));
        totalBytes += content.byteLength;
        found.set(relative, createHash("sha256").update(content).digest("hex"));
      } catch {
        // 读不到就跳过,不该因为一个文件让整次快照失败
      }
    }
  };

  await walk(root, "");
  return found;
}

/** 前后两张快照的差:新增的、以及内容变了的。 */
export function addedOrChanged(
  before: Map<string, string>,
  after: Map<string, string>,
): OutputRecord[] {
  const outputs: OutputRecord[] = [];

  for (const [path, sha256] of after) {
    if (before.get(path) === sha256) continue;
    outputs.push({ path, sha256 });
  }

  return outputs;
}

/** 原始数据区。相对工作区。 */
export const DATA_DIR = "data";

/** 路径(相对工作区)是不是落在原始数据区里。 */
export function isUnderDataDir(path: string): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\\/g, "/");
  return normalized === DATA_DIR || normalized.startsWith(`${DATA_DIR}/`);
}

/** 列出一个目录下所有文件的相对路径(任意扩展名)。 */
export async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), relative);
        continue;
      }
      if (entry.isFile()) found.push(relative);
    }
  };

  await walk(root, "");
  return found.sort();
}
