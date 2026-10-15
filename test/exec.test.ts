import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCommand, sha256Text } from "../src/exec.ts";

const workspace = await mkdtemp(join(tmpdir(), "mastic-exec-"));

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("跑命令", () => {
  it("正常命令返回退出码和输出", async () => {
    const result = await runCommand("echo hello", { cwd: workspace, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.stdoutSha256, sha256Text("hello\n"));
  });

  it("退出码如实反映失败", async () => {
    const result = await runCommand("exit 3", { cwd: workspace, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 3);
  });

  it("超时的命令会被杀掉", async () => {
    const result = await runCommand("sleep 60", { cwd: workspace, timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -1);
  });

  /**
   * 这条是拿一次真实事故换来的。
   *
   * worker 用 `python3 -m server.app &` 起了个测试服务,那个进程继承了
   * stdout/stderr。Node 的 'close' 事件要所有持有管道的人退出才触发,于是
   * 永远不触发,runCommand 的 Promise 永不 settle —— 没有超时、没有报错,
   * 一次运行静默挂死七个多小时,还留下几个孤儿服务占着端口。
   */
  it("命令起了后台进程,也不能把调用方挂住", async () => {
    const started = Date.now();
    const result = await runCommand("sleep 600 & echo started; sleep 0.2", {
      cwd: workspace,
      timeoutMs: 20_000,
    });
    const seconds = (Date.now() - started) / 1000;

    assert.ok(seconds < 10, `应当很快返回,实际用了 ${seconds.toFixed(1)}s`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "started");
  });

  it("后台进程会在命令结束时被一起收掉,不留在系统里", async () => {
    const marker = `mastic-test-${process.pid}`;
    await runCommand(`sleep 600 ${marker} & echo ok`, { cwd: workspace, timeoutMs: 20_000 });

    // 给 SIGKILL 一点时间落地
    await new Promise((resolve) => setTimeout(resolve, 300));

    // [s] 是必要的:不加的话 pgrep 会匹配到"执行 pgrep 的那个 shell"自己,
    // 因为它的命令行里就含这串字符
    const survivors = await runCommand(`pgrep -f '[s]leep 600 ${marker}' | wc -l`, {
      cwd: workspace,
      timeoutMs: 10_000,
    });
    assert.equal(survivors.stdout.trim(), "0", "不该留下孤儿进程");
  });
});
