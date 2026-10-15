/**
 * 一个刚好够用的 DOM 替身。
 *
 * 这台机器上没有浏览器,而前端最该被验的不是那几个纯函数,是「拿一份真实
 * payload 去渲染,会不会炸、渲染出来的东西对不对」。这层替身让我们能在
 * Node 里把 app.js 的真实渲染路径跑一遍。
 *
 * 只实现 app.js 真正用到的那几个 API,不追求完备。
 */

export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  innerHTML = "";
  textContent = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  value = "";

  private classes = new Set<string>();
  private attributesSvg: Record<string, string> = {};

  readonly classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    },
    contains: (name: string) => this.classes.has(name),
  };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set className(value: string) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    this.attributes.class = value;
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === "class") this.className = value;
  }

  getAttribute(name: string): string | undefined {
    return this.attributes[name];
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  addEventListener(): void {
    // 事件在替身里不派发,注册即忽略
  }

  closest(): FakeElement | null {
    return null;
  }

  /** 递归收集整棵子树的 HTML,便于断言。 */
  serialise(): string {
    const own = this.innerHTML;
    const kids = this.children.map((child) => child.serialise()).join("");
    return `${own}${kids}`;
  }
}

export interface FakeDocument {
  getElementById(id: string): FakeElement;
  createElement(tag: string): FakeElement;
  createElementNS(_ns: string, tag: string): FakeElement;
  querySelectorAll(): FakeElement[];
  /** 测试用:拿到某个 id 的元素。 */
  find(id: string): FakeElement;
}

/** ids 应当来自 index.html —— 让替身里的元素集合和真实页面保持一致。 */
export function installDom(ids: string[]): FakeDocument {
  const registry = new Map<string, FakeElement>();
  for (const id of ids) registry.set(id, new FakeElement("div"));

  const document: FakeDocument = {
    getElementById(id) {
      const element = registry.get(id);
      if (element === undefined) throw new Error(`DOM 里没有 id="${id}" 的元素`);
      return element;
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    find: (id) => {
      const element = registry.get(id);
      if (element === undefined) throw new Error(`DOM 里没有 id="${id}" 的元素`);
      return element;
    },
  };

  (globalThis as { document?: unknown }).document = document;
  return document;
}

/** 从 index.html 里抠出所有 id,替身据此建元素。 */
export function idsFromHtml(html: string): string[] {
  return [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1] ?? "").filter(Boolean);
}
