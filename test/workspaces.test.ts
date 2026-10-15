import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadWorkspaceRegistry } from "../src/workspaces.ts";

const root = await mkdtemp(join(tmpdir(), "mastic-ws-"));
const store = join(root, "workspaces.json");

/** 每个用例一个独立目录,免得互相踩。 */
async function makeDir(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

const alice = await makeDir("alice");
const bob = await makeDir("bob");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("工作区注册表", () => {
  it("当前工作区就是启动时给的那个", async () => {
    const registry = await loadWorkspaceRegistry(alice, store);
    assert.equal(registry.current(), alice);
  });

  it("切到存在的目录,当前跟着变", async () => {
    const registry = await loadWorkspaceRegistry(alice, store);
    assert.deepEqual(await registry.switchTo(bob), { ok: true, path: bob });
    assert.equal(registry.current(), bob);
  });

  it("切到不存在的目录会被拒,而且当前不变", async () => {
    const registry = await loadWorkspaceRegistry(alice, store);
    const result = await registry.switchTo(join(root, "并不存在"));

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.error.includes("不存在"));
    assert.equal(registry.current(), alice, "被拒之后当前工作区不该变");
  });

  it("切到一个文件(不是目录)也会被拒", async () => {
    const file = join(root, "一个文件.txt");
    await writeFile(file, "x", "utf8");

    const registry = await loadWorkspaceRegistry(alice, store);
    const result = await registry.switchTo(file);

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.error.includes("不是目录"));
  });

  it("空路径被拒", async () => {
    const registry = await loadWorkspaceRegistry(alice, store);
    assert.equal((await registry.switchTo("   ")).ok, false);
    assert.equal(registry.current(), alice);
  });

  it("用过的工作区会被记住,最近的在最前", async () => {
    const registry = await loadWorkspaceRegistry(alice, store);
    await registry.switchTo(bob);
    await registry.switchTo(alice);

    const list = registry.list();
    assert.equal(list[0], alice, "刚切过去那个应当排第一");
    assert.ok(list.includes(bob), "切走过的也应当还在");
  });

  it("记下来的清单重开还在 —— 不然每次重启都要重打一遍路径", async () => {
    const path = join(root, "persist.json");
    const first = await loadWorkspaceRegistry(alice, path);
    await first.switchTo(bob);

    const second = await loadWorkspaceRegistry(join(root, "随便"), path);
    assert.ok(second.list().includes(bob), "重启后应当还记得 bob");
    assert.ok(second.list().includes(alice), "也应当记得 alice");
  });

  it("清单文件坏了也不影响用,只是记不住", async () => {
    const path = join(root, "broken.json");
    await writeFile(path, "{ 这不是 JSON", "utf8");

    const registry = await loadWorkspaceRegistry(alice, path);
    assert.equal(registry.current(), alice);
    assert.deepEqual(registry.list(), [alice]);
  });
});
