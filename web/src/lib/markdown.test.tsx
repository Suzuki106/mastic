import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

/**
 * 这段渲染的是**模型写的、不可信的内容**,所以它是前端最该被测的地方。
 *
 * 这版实现根本不生成 HTML 字符串,也就不存在"忘了转义"。这里测的正是
 * 那条性质:无论喂什么进去,出来的都只能是文本,不能是标记。
 */
function render(source: string): string {
  return renderToStaticMarkup(<Markdown source={source} />);
}

describe("Markdown 渲染", () => {
  it("script 标签只会变成文本", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("img 上的事件处理器也进不来", () => {
    const html = render('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  // 注意:外层容器本身就是 <div>,所以断言不能只看 "<div" ——
  // 得盯住那个**带属性的**危险标签有没有被原样放出来。
  it("代码块里的尖括号照样是文本", () => {
    const html = render("```\n<div onclick=x>危险</div>\n```");
    expect(html).not.toContain("<div onclick");
    expect(html).toContain("&lt;div onclick=x&gt;");
  });

  it("行内代码里的内容不会被当成标记", () => {
    const html = render("命令是 `a **b** c` 这样");
    expect(html).toContain("<code");
    expect(html).toContain("a **b** c");
    expect(html).not.toContain("<strong");
  });

  it("标题、列表、强调都认", () => {
    const html = render("## 小标题\n\n- 一\n- 二\n\n这是**重点**。");
    expect(html).toContain("小标题");
    expect(html).toContain("<ul");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
    expect(html).toMatch(/<strong[^>]*>重点<\/strong>/);
  });

  it("围栏代码块里的 # 不会被当成标题", () => {
    const html = render("```\n# 这不是标题\n```");
    expect(html).not.toContain("<h1");
    expect(html).toContain("# 这不是标题");
  });

  it("空输入不炸,也不产出任何块级内容", () => {
    // 外层容器永远在,所以看的是"里面有没有东西"
    expect(render("")).not.toContain("<p");
    expect(render("")).not.toContain("<pre");
    expect(render("   \n  ")).not.toContain("<p");
  });
});
