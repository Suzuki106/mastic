#!/usr/bin/env bash
#
# 一个**不使用 mastic agent** 的运行时。
#
# 它只做三件事:跑一条命令、自己算退出码和 stdout 哈希、按 mastic 的报告
# 格式写一份文件。之后用 `mastic evidence verify` 判这份报告 —— 证明证据层
# 不绑定 mastic 的规划 / 执行循环。
#
# 用法:
#   bash run.sh <工作区> "<命令>"
#   例:bash run.sh /tmp/demo "echo hello"

set -euo pipefail

workspace="${1:?用法: bash run.sh <工作区> <命令>}"
command="${2:?用法: bash run.sh <工作区> <命令>}"

mkdir -p "$workspace"
cd "$workspace"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
trap 'rm -f "$stdout_file" "$stderr_file"' EXIT

set +e
bash -c "$command" >"$stdout_file" 2>"$stderr_file"
exit_code=$?
set -e

stdout_sha="$(sha256sum "$stdout_file" | cut -d' ' -f1)"
stdout_bytes="$(wc -c <"$stdout_file" | tr -d ' ')"

mkdir -p .mastic/evidence-example
report=".mastic/evidence-example/report.md"

cat >"$report" <<REPORT
---
task: T-EXAMPLE
status: unverified
claims:
  - statement: 这条命令被执行过,退出码与输出哈希由执行它的运行时自己记录
    evidence:
      - kind: command
        run: "$command"
        cwd: "."
        exit_code: $exit_code
        stdout_sha256: $stdout_sha
        stdout_bytes: $stdout_bytes
unresolved: []
---

## 做了什么

一个不是 mastic 的运行时执行了这条命令,自己记下退出码和 stdout 哈希,
按 mastic 的报告格式落盘。mastic 没有参与执行,只会在下一步判定。
REPORT

echo "$workspace/$report"
