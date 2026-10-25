# 不经过 mastic 的 agent,也能被 mastic 判

这个例子证明「证据层」不绑定 mastic 的规划 / 执行循环。

`run.sh` 扮演一个外部运行时:它跑一条命令,自己记下退出码和 stdout 哈希,
按报告格式写文件。mastic 全程没有参与执行。

```bash
bash examples/evidence-only/run.sh /tmp/mastic-evidence-demo "echo hello"

npm run mastic -- evidence verify \
  /tmp/mastic-evidence-demo/.mastic/evidence-example/report.md \
  --workspace /tmp/mastic-evidence-demo
```

再试一次伪造 —— 把报告里的 `stdout_sha256` 改成任意 64 个字符,重跑上面第二行,
裁定会变成 `contradicted`。这一层不信任何运行时送来的数字,它只认重放。

同时,任何运行时都可以按同样的报告格式接入:

- `claims[].evidence[]` 写 `kind: command` / `file` / `url`;
- `command` 证据带 `run`、`cwd`、`exit_code`、`stdout_sha256`;
- `file` 证据带 `path`、`sha256`;
- 一条 claim 没有证据,在解析阶段就不合法。

需要的话,`--json` 给出机器可读的裁定,方便接 CI。
