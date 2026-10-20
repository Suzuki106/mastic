import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { sha256Text } from "../exec.ts";
import { recordFile } from "../ledger.ts";
import type { ContentPart } from "../llm.ts";
import { displayPath, resolveInside } from "../paths.ts";
import type { Tool } from "./index.ts";

/** 单张图的上限。和用户上传那边保持一致。 */
export const MAX_READ_IMAGE_BYTES = 4 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * 看一眼工作区里的图片。
 *
 * 任务开局能看到的那几张,是任务书 `inputs` 里声明的。执行中途要看别的图
 * ——测试产出的截图、仓库里已有的图、抓下来的一张图——就靠这个。
 *
 * **它只是"看",不是"证据"。** 图片没有可以重放的输出,所以它不会被当成
 * 证据引用;而且读进来的图同样要过溯源检查:一份磁盘上的 `random_noise.png`
 * 拿去做实验,和编一份 CSV 是一回事。
 */
export const readImageTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "read_image",
      description:
        "读取工作目录内的一张图片并**直接看到它**。支持 PNG / JPEG / WebP / GIF,单张 4MB 以内。\n" +
        "注意:图片不能被当成实验证据(它不可重放),而且没来源的图不能当实验输入。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的路径。" } },
        required: ["path"],
      },
    },
  },

  async run(args, ctx): Promise<ContentPart[]> {
    const path = args.path;
    if (typeof path !== "string" || path.trim() === "") throw new Error("`path` 必须是非空字符串");

    const full = resolveInside(ctx.workspace, path);
    const extension = extname(full).toLowerCase();
    const mediaType = MEDIA_TYPES[extension];
    if (mediaType === undefined) {
      throw new Error(`\`${path}\` 不是支持的图片格式(只认 ${Object.keys(MEDIA_TYPES).join(" / ")})`);
    }

    const info = await stat(full).catch(() => undefined);
    if (info === undefined) throw new Error(`读不到 \`${path}\``);
    if (info.size > MAX_READ_IMAGE_BYTES) {
      throw new Error(`\`${path}\` 有 ${(info.size / 1024 / 1024).toFixed(1)}MB,超过 4MB 上限`);
    }

    const bytes = await readFile(full);

    // 记进台账。不是证据(图片不可重放),但让"这个 worker 看过哪张图"有记录,
    // 数据溯源检查也靠它认出来这张图被当输入用了。
    const entry = recordFile(ctx.ledger, {
      path: displayPath(ctx.workspace, full),
      sha256: sha256Text(bytes.toString("base64")),
      action: "read",
    });

    return [
      { type: "text", text: `${entry.id} | ${entry.path}(${bytes.byteLength} 字节)` },
      { type: "image_url", image_url: { url: `data:${mediaType};base64,${bytes.toString("base64")}` } },
    ];
  },
};
