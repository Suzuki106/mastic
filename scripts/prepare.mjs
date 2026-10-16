#!/usr/bin/env node
/**
 * `npm install` 之后跑一次。
 *
 * 开发机上(以及从 git 装的时候)要顺手把前端构建出来;但从 tarball 解包出来
 * 只装运行时依赖时,**构建工具根本没装**,而 `web/dist` 已经在包里了 ——
 * 那时候再去调 vite 只会报一句 "vite: not found",看着像装坏了。
 *
 * 所以先看构建工具在不在,不在就安静跳过。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const vite = resolve("node_modules", "vite");

if (!existsSync(vite)) {
  console.log("没有构建工具(vite),跳过前端构建 —— web/dist 应该已经在包里了。");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:web"], { stdio: "inherit" });
process.exit(result.status ?? 1);
