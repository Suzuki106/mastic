#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 单独放一个 .mjs 而不是让 npm 直接指向 src/cli.ts,有两个原因:
 *
 * 1. `src/cli.ts` 要保持是纯 TypeScript(不带 shebang),那样被 import 时
 *    不会被当成可执行脚本。
 * 2. `.env` 要按**当前目录**找,不是按包安装在哪找。用参数调 CLI 的人,
 *    期望的是"在我正站着的这个项目里读它的 .env"。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

await import(new URL("../src/cli.ts", import.meta.url).href);
