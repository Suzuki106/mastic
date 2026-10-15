# mastic

> 文档驱动的多 agent —— 让 agent 的产出变成**可验收、可追溯、可反驳**的文档。

## 它解决什么

多 agent 系统最常见的失败不是"跑不起来",是**跑起来了但结果不可信**。

你去问一个 agent"做完了吗",它说做完了。你看代码,发现关键函数是个空壳,
注释里写着"此处待实现"。你问它为什么,它说"我假设下游会处理"。

问题不在于模型不老实,在于**它没有说"我不知道"的余地,也没有说"我做完了"的代价**。
在大多数 agent 框架里,「完成」是一个自报的状态,不是一个被验证的结论。

mastic 换了个做法:**agent 之间不靠共享上下文通信,靠文档通信**;
而每一份文档都必须带着**可重放的证据**才能算数。

```bash
mastic run "实现 src/slugify.js,让 test/slugify.test.js 全部通过"
```

## 核心机制

### 一、指标 = 可执行谓词,分三级下沉

"给一切任务都定出指标"不是靠发明一个万能指标,而是靠逐级下沉。
每个任务恰好落在某一级,级别写进任务书 —— 前端据此显示"这个任务靠跑 X 验"
还是"这个任务是一条待证陈述"。

| 级别 | 形式 | 判定 |
|---|---|---|
| `command` | `run: "npm test", expect: {exit_code: 0}` | 真跑,看退出码 / 解析 stdout |
| `structural` | `require: [evidence_for_every_claim, ...]` | 文档结构的机械校验 |
| `statement` | 一条可证伪的陈述 | 要么给出证据,要么显式标为未验证 |

### 二、反 mock 的四道闸

1. **声明与证据分离。** 报告里 `claims[].statement` 没有 `evidence` 就是**结构性非法**,
   解析阶段直接拒掉 —— 不是靠祈祷它诚实,是它写不出来。
2. **worker 手里没有可编造的数字。** worker 只写台账编号(`ref: C3`),
   退出码和 stdout 哈希由 mastic 在执行的那一刻记下、落盘时展开。它想编都没得编。
3. **证据必须可重放。** verifier 把每条证据**真跑一遍**。对不上就再跑一次做判别:
   两次新跑互不相同 → 命令本身不稳定,判 `drifted`(软);
   两次新跑一模一样却和报告对不上 → 报告里那个数是编的,判 `contradicted`(硬)。
4. **禁词 lint。** 假设 / 模拟 / 大概 / assume / mock / simulate …… 命中即打回。
   引用不算主张:代码块和行内代码里的命令原文、测试输出不参与这项检查。

### 三、状态由 verifier 裁定,不由 worker 自报

worker 提交的是**主张**,verifier 落的是**裁定**。worker 交的草稿里连 `status`
这个字段都没有 —— 它没资格说"完成",只能说 `blocked: <卡在哪>`。

```
verified      所有验收通过,且每条证据都重放成功
unverified    没有失败项,但有东西没验成 —— 合法终态,会逐条列出
contradicted  验收没过、证据重放对不上、或踩了致命 lint
blocked       走不下去(缺输入 / 需要人拍板)
```

**失败是合法终态。** 一个不许说"我不知道"的系统,必然学会说"我做完了"。

## 快速开始

需要 Node ≥ 23.6(直接跑 `.ts`,无需编译)。

```bash
git clone https://github.com/Suzuki106/mastic.git
cd mastic
npm install

cp .env.example .env      # 填一个 OpenAI 兼容接口的 key(默认 DeepSeek)
vim .env

npm run mastic -- run "把 README 里的 TODO 都补上"
```

任何兼容 `POST /chat/completions` 的服务都能用 —— OpenAI、DeepSeek、月之暗面、
本地 Ollama,改 `.env` 里的 `OPENAI_BASE_URL` 即可。

## 命令

```bash
mastic run "<目标>"        # 拆任务树 → 并行执行 → 逐任务验收
mastic ui [run-id]         # Web 界面:任务树 / 文档 / 实时事件流
mastic verify [run-id]     # 对已有运行重跑验收(证据重放 + 验收命令)
mastic check [run-id]      # 只校验文档,不跑命令、不碰模型(可进 CI)
```

常用选项:`--workspace <路径>` `--concurrency <n>` `--retries <n>` `--port <n>` `--quiet`

`check` 不加载 API key,所以它能直接进 CI —— 拿它守住"文档别退化成散文"。

## 一次运行留下什么

所有产物落在 `<工作区>/.mastic/runs/<run-id>/`:

```
run.md              运行级 frontmatter:目标、状态、token 用量
tasks/T-001.md      任务书(planner 产出)
reports/T-001.md    交付报告(worker 产出、verifier 裁定)
events.jsonl        只追加的事件流,前端的数据源
```

**任务书**长这样(真实产物,节选):

```yaml
---
id: T-001
title: 让 src/slugify.js 满足 test/slugify.test.js 的四条断言
goal: 在 src/slugify.js 提供 ESM 具名导出 slugify(str),使 npm test 全绿。
depends_on: []
deliverable: reports/T-001.md
acceptance:
  - kind: command
    run: npm test
    expect: { exit_code: 0, stdout_contains: "fail 0" }
  - kind: structural
    require: [evidence_for_every_claim, no_forbidden_words, no_unresolved]
constraints:
  - 不得修改 test/slugify.test.js 与 package.json
  - 不引入任何第三方依赖
budget: { max_steps: 24 }
---
## 背景
## 交付要求
```

**交付报告**里的证据是展开后的真值 —— worker 写的是 `ref: C3`,那一串数字是 mastic 填的:

```yaml
---
task: T-001
status: verified          # 由 verifier 裁定,不是 worker 写的
claims:
  - statement: npm test 退出码为 0,stdout 含 "tests 4"、"pass 4"、"fail 0"
    evidence:
      - kind: command
        run: npm test
        cwd: .
        exit_code: 0
        stdout_sha256: 84f10bd447fca371…
verdict:
  reasons: ["全部验收通过,且每条证据都重放成功。"]
  checks:
    - { kind: command,  label: "npm test", passed: true,  detail: "退出码 0" }
    - { kind: evidence, label: "证据 `npm test`", passed: false, detail: "输出不是逐字节可复现的" }
---

## 做了什么
## 证据
## 未解决
```

## Web 界面

`mastic ui` 起一个本地服务(默认 <http://127.0.0.1:7777>),三块:

- **左**:任务 DAG,节点按状态着色(已验证 / 未验全 / 对不上 / 卡住)
- **中**:选中任务的文档 —— 裁定逐条 pass/fail、主张与证据、正文
- **右**:实时事件流。`mastic run` 和 `mastic ui` 是两个进程,
  前端直接 tail `events.jsonl`,所以**一边跑一边看**是能用的

因为文档 schema 是严格的,前端解析不需要任何启发式。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 必填 | 任何 OpenAI 兼容接口的 key |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | 接口地址 |
| `OPENAI_MODEL` | `deepseek-chat` | 模型名 |
| `MASTIC_WORKSPACE` | 当前目录 | agent 动手的目录 |
| `MASTIC_CONCURRENCY` | `3` | 同时跑几个 worker |
| `MASTIC_MAX_RETRIES` | `2` | 判 contradicted 后最多重派几次 |
| `MASTIC_MAX_STEPS` | `24` | worker 单个任务最多几步 |
| `MASTIC_COMMAND_TIMEOUT_MS` | `300000` | 验收命令超时 |
| `MASTIC_REQUEST_IDLE_TIMEOUT_MS` | `120000` | 模型流空闲多久判断流(空闲超时,不是总时长) |

## 项目结构

依赖方向是设计的一部分 —— 越靠下的层越纯,底下三层完全不碰模型:

```
src/
  cli.ts            命令入口
  orchestrator.ts   调度:分层、并行、带 findings 重派
  inspect.ts        check / verify 两个只读命令
  server.ts         HTTP:静态前端 + REST + SSE
  agent/            只有这三处调模型
    loop.ts         工具循环(交卷工具 + 校验打回)
    planner.ts      目标 → 任务树
    worker.ts       任务书 → 交付报告
    verifier.ts     报告 → 裁定(机械判定优先,模型只判陈述级)
  check/            纯函数,零模型调用
    run.ts          三级验收执行器
    replay.ts       证据重放(含"再跑一次"判别实验)
    verdict.ts      定状态
  doc/              纯数据,零 IO
    frontmatter.ts  YAML frontmatter 读写
    validate.ts     手写字段校验(错误消息会回灌给模型,所以不用 zod)
    task.ts         任务书 schema
    report.ts       交付报告 schema
    lint.ts         禁词 / 证据 / 结构校验
    plan.ts         任务树校验与分层
  tools/            read_file / write_file / list_dir / run_bash
  llm.ts            OpenAI 兼容流式客户端(带空闲超时)
  config.ts         环境变量
  ledger.ts         证据台账
  exec.ts           命令执行(自己计时杀进程)
  workspace.ts      落盘布局
  events.ts         只追加的事件流
  paths.ts          路径钉在工作目录内
  web/              前端(index.html / app.js / style.css,无构建)
test/               用例全部离线,不需要 API key
```

## 测试

```bash
npm test          # node --test,全部离线
npm run typecheck # tsc --noEmit
```

覆盖的是**不需要 API key 的那部分** —— 也就是真正承载项目主张的那部分:

- 文档 schema:没证据的 claim 收不下、空判据的验收收不下、越界路径挡得住
- 证据重放:**编造的哈希判 contradicted**,而带时间戳的老实证据只判 drifted
- 禁词 lint:中文英文都抓得到,`allow_terms` 是唯一出口,引用不算主张
- 裁定:九种组合,含"worker 主动喊停 → blocked,即使别的都过了"
- 前端:渲染真实 payload 不炸、先转义再上标记、DAG 分层正确

## 设计取舍

**为什么证据要重放两次。** 一次重放分不清"命令本身不稳定"和"这个哈希是编的"。
第二次重跑是判别实验:稳定性是可观测的,编造因此无处藏身。

**为什么 `unverified` 是合法终态。** agent 会说谎,是因为 schema 逼着它把结论填满。
给它一个体面的"我不知道",它才不需要编。

**为什么禁词表里没有 TODO / FIXME。** 那不是"在编",是"没写完"。
而且 `node --test` 的输出里天然有一行 `ℹ todo 0`,放进禁词表必然误伤每一份老实报告。

**为什么前端没有构建步骤。** 浏览器直接加载 `src/web/` 下的三个文件。
少一层工具链,少一处会过期的东西。

## 许可

MIT
