import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { escapeHtml, layout, renderMarkdown } from "../src/web/app.js";

describe("前端 Markdown 渲染", () => {
  it("先转义再做标记 —— 模型给的内容不能注入 HTML", () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("代码块里的尖括号同样被转义", () => {
    const html = renderMarkdown("```\n<img src=x onerror=alert(1)>\n```");
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img"));
  });

  it("行内代码里的内容不会被当成标记", () => {
    const html = renderMarkdown("命令是 `a **b** c` 这样");
    assert.ok(html.includes("<code>a **b** c</code>"));
    assert.ok(!html.includes("<strong>"));
  });

  it("标题、列表、强调都认", () => {
    const html = renderMarkdown("## 小标题\n\n- 一\n- 二\n\n这是**重点**。");
    assert.ok(html.includes("<h3>小标题</h3>"));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
    assert.ok(html.includes("<strong>重点</strong>"));
  });

  it("代码块里的 # 不会被当成标题", () => {
    const html = renderMarkdown("```\n# 这不是标题\n```");
    assert.ok(!html.includes("<h1>"));
    assert.ok(html.includes("# 这不是标题"));
  });

  it("空输入不炸", () => {
    assert.equal(renderMarkdown("").trim(), "");
    assert.equal(renderMarkdown(undefined).trim(), "");
  });
});

describe("escapeHtml", () => {
  it("五个危险字符都转", () => {
    assert.equal(escapeHtml(`&<>"`), "&amp;&lt;&gt;&quot;");
  });
});

describe("任务树分层", () => {
  const meta = [
    { id: "T-001", depends_on: [] },
    { id: "T-002", depends_on: ["T-001"] },
    { id: "T-003", depends_on: ["T-001"] },
    { id: "T-004", depends_on: ["T-002", "T-003"] },
  ];

  it("无依赖的排第一层,依赖都满足后才下沉", () => {
    const layers = layout(meta).map((layer) => layer.map((data) => data.id));
    assert.deepEqual(layers, [["T-001"], ["T-002", "T-003"], ["T-004"]]);
  });

  it("互不依赖的同层并排", () => {
    const layers = layout([
      { id: "A", depends_on: [] },
      { id: "B", depends_on: [] },
    ]);
    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.length, 2);
  });

  it("有环也不会死循环", () => {
    const layers = layout([
      { id: "A", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] },
    ]);
    assert.equal(layers.flat().length, 2);
  });
});

describe("前端与页面接线", () => {
  it("app.js 引用的每个元素 id 都真实存在于 index.html", async () => {
    const [app, html] = await Promise.all([
      readFile(new URL("../src/web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../src/web/index.html", import.meta.url), "utf8"),
    ]);

    const referenced = [...app.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
    assert.ok(referenced.length > 0, "没找到任何 getElementById,检查是不是正则失效了");

    const missing = referenced.filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `index.html 里缺这些 id:${missing.join(", ")}`);
  });
});
