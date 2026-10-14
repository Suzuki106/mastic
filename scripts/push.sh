#!/usr/bin/env bash
# 把当前分支推到 origin,遵守两条:
#   1. 失败必须明确失败 —— 绝不把失败报成成功。
#   2. 网络抖动要重试 —— 这台机器连 github 偶尔会卡到超时。
#
# 背景:这台机器没有 gh,也没配 credential.helper,所以用一次性凭据 helper
# 把 GH_TOKEN 递给 git,令牌不会落进 argv、也不会写进 .git/config。

set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN 没设置,推不了。" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# credential.interactive=never 很关键:token 万一无效,git 会退回去交互式
# 问用户名密码,而在非交互环境里那就是无限期挂住。
helper='!f() { echo username=x-access-token; echo password="$GH_TOKEN"; }; f'
attempts=3

for attempt in $(seq 1 "$attempts"); do
  if git -c credential.helper="$helper" -c credential.interactive=never push origin main; then
    exit 0
  fi

  echo "推送失败(第 ${attempt}/${attempts} 次)" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep 3
  fi
done

echo "连续 ${attempts} 次推送失败:提交还在本地,没有推上去。" >&2
exit 1
