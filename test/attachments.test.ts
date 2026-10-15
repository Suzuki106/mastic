import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  imageToDataUrl,
  loadImages,
  MAX_IMAGE_BYTES,
  parseDataUrl,
  saveImage,
} from "../src/attachments.ts";

const root = await mkdtemp(join(tmpdir(), "mastic-attach-"));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 一张最小的合法 PNG(1×1 透明像素)。 */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG}`;

describe("解析 data URL", () => {
  it("收得下合法 PNG", () => {
    const parsed = parseDataUrl(DATA_URL);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.mediaType, "image/png");
    assert.ok(parsed.bytes > 0);
  });

  it("拒绝不支持的图片类型", () => {
    const parsed = parseDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    assert.ok("error" in parsed);
    assert.ok(parsed.error.includes("不支持"));
  });

  // SVG 是能带脚本的,放进 data URL 再被浏览器渲染出来就是个 XSS 面
  it("SVG 一定进不来", () => {
    assert.ok("error" in parseDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="));
  });

  it("拒绝不是 data URL 的字符串", () => {
    assert.ok("error" in parseDataUrl("https://example.com/a.png"));
    assert.ok("error" in parseDataUrl("随便写的"));
  });

  it("超过 4MB 的图被拒", () => {
    const huge = `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1024).toString("base64")}`;
    const parsed = parseDataUrl(huge);
    assert.ok("error" in parsed);
    assert.ok(parsed.error.includes("超过"));
  });
});

describe("落盘与读回", () => {
  it("写进 attachments/,返回相对 run 目录的路径", async () => {
    const saved = await saveImage(root, 0, { dataUrl: DATA_URL, name: "屏幕截图.png" });
    assert.ok(!("error" in saved));
    assert.equal(saved.path, join("attachments", "1.png"), "文件名由我们编,不用用户给的");

    const written = await readFile(join(root, saved.path));
    assert.equal(written.toString("base64"), PNG, "字节要原样落盘");
  });

  it("序号进文件名,多张不会互相覆盖", async () => {
    const a = await saveImage(root, 1, { dataUrl: DATA_URL });
    const b = await saveImage(root, 2, { dataUrl: DATA_URL });
    assert.ok(!("error" in a) && !("error" in b));
    assert.notEqual(a.path, b.path);
  });

  it("用用户文件名的后缀,但只取后缀", async () => {
    const saved = await saveImage(root, 3, { dataUrl: DATA_URL, name: "../../坏名字.jpg" });
    assert.ok(!("error" in saved));
    assert.equal(saved.path, join("attachments", "4.jpg"));
    assert.ok(!saved.path.includes(".."), "用户给的名字不能影响路径");
  });

  it("读回来是能直接发给模型的 data URL", async () => {
    const saved = await saveImage(root, 4, { dataUrl: DATA_URL });
    assert.ok(!("error" in saved));

    const back = await imageToDataUrl(root, saved.path);
    assert.equal(back, DATA_URL, "一来一回应当一模一样");
  });

  it("文件不在时给 null,不抛", async () => {
    assert.equal(await imageToDataUrl(root, "attachments/并不存在.png"), null);
  });

  it("越界路径读不到", async () => {
    assert.equal(await imageToDataUrl(root, "../../../etc/passwd"), null);
  });

  it("loadImages 跳过丢掉的图,不因为一张缺失把整轮搞挂", async () => {
    const saved = await saveImage(root, 5, { dataUrl: DATA_URL });
    assert.ok(!("error" in saved));

    const blocks = await loadImages(root, [saved.path, "attachments/没有这张.png"]);
    assert.equal(blocks.length, 1, "只该剩能读到的那一张");
    assert.equal(blocks[0]?.type, "image_url");
  });

  it("坏图不会被保存", async () => {
    const result = await saveImage(root, 9, { dataUrl: "不是图片" });
    assert.ok("error" in result);
  });
});

describe("端到端:写进去再读出来", () => {
  it("内容不变", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mastic-attach2-"));
    try {
      const bytes = Buffer.from("假装这是一张图的内容");
      const dataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;

      const saved = await saveImage(dir, 0, { dataUrl, name: "a.webp" });
      assert.ok(!("error" in saved));

      await writeFile(join(dir, "marker"), "x", "utf8");
      const back = await imageToDataUrl(dir, saved.path);
      assert.equal(back, dataUrl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
