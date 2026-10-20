import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { resolveInside } from "./paths.ts";
import { appendProvenance } from "./provenance.ts";

/**
 * 用户随需求一起传上来的图片。
 *
 * 它们和任务书、报告一样落在 run 目录里(`attachments/`),因为**图片也是证据的
 * 一部分**:任务书里会写"If 图里那个按钮是灰的,就…",后来的人得能翻回来看
 * 当时那张图长什么样。
 */

export const MAX_IMAGES = 50;
/**
 * 一次上传的**总量**上限。
 *
 * 单张 4MB × 50 张是 200MB,而服务端是把整个请求体读进内存的 ——
 * 不设总量的话,一次误操作就能把进程撑死。64MB 足够 50 张普通截图。
 */
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 这几种是各家接口普遍认的。别的一律拒掉,免得发过去才报错。 */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export interface IncomingImage {
  /** 用户那边的文件名,只用来取个可读的后缀。 */
  name?: string;
  /** `data:image/png;base64,...` */
  dataUrl: string;
}

export interface ParsedImage {
  mediaType: string;
  base64: string;
  bytes: number;
}

export function parseDataUrl(dataUrl: string): ParsedImage | { error: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    return { error: "只接受 base64 的 data URL(形如 data:image/png;base64,…)。" };
  }

  const mediaType = match[1].toLowerCase();
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    return { error: `不支持的图片类型 ${mediaType},只接受 ${ALLOWED_IMAGE_TYPES.join(" / ")}。` };
  }

  // base64 的字节数可以反算,不用先解码一遍
  const base64 = match[2];
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) {
    return { error: `图片 ${(bytes / 1024 / 1024).toFixed(1)}MB,超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限。` };
  }

  return { mediaType, base64, bytes };
}

/** 把用户给的文件名洗成一个安全的短名 —— 只留后缀,名字我们自己编。 */
function safeExtension(name: string | undefined, mediaType: string): string {
  if (name !== undefined) {
    const ext = extname(basename(name)).toLowerCase();
    if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  return EXTENSIONS[mediaType] ?? ".png";
}

export interface SavedImage {
  /** 相对 run 根目录,会写进任务书的 inputs。 */
  path: string;
  mediaType: string;
  bytes: number;
}

/**
 * 把一张图写进 run 目录。
 *
 * 文件名由我们编(1.png、2.jpg……),不用用户给的名字 —— 那是不可信输入,
 * 而且中文名、重名、路径分隔符都得处理,不如直接丢掉。
 */
export async function saveImage(
  runRoot: string,
  index: number,
  image: IncomingImage,
): Promise<SavedImage | { error: string }> {
  const parsed = parseDataUrl(image.dataUrl);
  if ("error" in parsed) return parsed;

  const relative = join("attachments", `${index + 1}${safeExtension(image.name, parsed.mediaType)}`);
  const target = resolveInside(runRoot, relative);
  const bytes = Buffer.from(parsed.base64, "base64");

  await mkdir(join(runRoot, "attachments"), { recursive: true });
  await writeFile(target, bytes);

  // 记进溯源链。用户提供和外部抓取是两个并列的合法来源 ——
  // 实验拿它当输入时,得能沿链走回这里,而不是走回"模型写的"。
  await appendProvenance(join(runRoot, "provenance.jsonl"), {
    kind: "user",
    path: relative,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    contentType: parsed.mediaType,
    ...(image.name === undefined ? {} : { note: `用户上传:${image.name}` }),
  });

  return { path: relative, mediaType: parsed.mediaType, bytes: parsed.bytes };
}

/** 读回来发给模型。接口读不到我们的磁盘,只能塞 data URL。 */
export async function imageToDataUrl(runRoot: string, relative: string): Promise<string | null> {
  try {
    const content = await readFile(resolveInside(runRoot, relative));
    const extension = extname(relative).toLowerCase();
    const mediaType =
      Object.entries(EXTENSIONS).find(([, ext]) => ext === extension)?.[0] ?? "image/png";
    return `data:${mediaType};base64,${content.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 一批路径 → 一批图片内容块。读不到的跳过,不让一张丢图把整轮搞挂。 */
export async function loadImages(
  runRoot: string,
  paths: string[],
): Promise<{ type: "image_url"; image_url: { url: string } }[]> {
  const loaded = await Promise.all(paths.map((path) => imageToDataUrl(runRoot, path)));
  return loaded.flatMap((url) => (url === null ? [] : [{ type: "image_url" as const, image_url: { url } }]));
}
