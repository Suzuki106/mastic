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
   两次新跑互不相同 → 命令本身不稳定,判 `drifted`;
   两次新跑一模一样却和报告对不上 → 这条记录站不住,判 `contradicted`(硬)。

   注意 `drifted` **不降级**:退出码对上了就说明这条命令的结果确实如此,
   输出不逐字节可复现只是那份抄件的性质。界面上标 ⚠,状态不动。
4. **禁词 lint。** 假设 / 模拟 / 大概 / assume / mock / simulate …… 命中即打回。
   引用不算主张:代码块和行内代码里的命令原文、测试输出不参与这项检查。

### 三、状态由 verifier 裁定,不由 worker 自报

worker 提交的是**主张**,verifier 落的是**裁定**。worker 交的草稿里连 `status`
这个字段都没有 —— 它没资格说"完成",只能说 `blocked: <卡在哪>`。

```
verified      验收全过,且没有证据对不上
unverified    有证据根本没法验(例如引了 URL,内容随时间变)
contradicted  验收没过、证据重放对不上、踩了致命 lint、或该清干净的没清干净
blocked       走不下去(缺输入 / 需要人拍板)
```

**验收就是「完成」的定义。** 判据全过就是做完了 —— 报告里那些交代方法、
划范围、承认能力边界的条目照样显示给人看,但不改状态。

**失败是合法终态。** 一个不许说"我不知道"的系统,必然学会说"我做完了"。

## 快速开始

需要 Node ≥ 23.6。后端直接跑 `.ts`(Node 原生擦除类型,不经编译);
前端走 Vite,`npm install` 时会自动构建一次。

```bash
git clone https://github.com/Suzuki106/mastic.git
cd mastic
npm install               # 装依赖,并顺手把前端构建好(约 0.3s)

cp .env.example .env      # 填一个 OpenAI 兼容接口的 key(默认 DeepSeek)
vim .env
```

然后两种用法,任选:

```bash
npm run mastic -- ui      # 图形界面:在界面里写需求、看它跑

npm run mastic -- run "把 README 里的 TODO 都补上"    # 命令行
```

任何兼容 `POST /chat/completions` 的服务都能用 —— OpenAI、DeepSeek、月之暗面、
本地 Ollama,改 `.env` 里的 `OPENAI_BASE_URL` 即可。

前端改完要重新构建:`npm run build:web`。开发时用 `npm run dev:web`
(带热更新,并把 `/api` 代理到 7777 上的 `mastic ui`)。

### 装到服务器上

`npm pack` 打一个包(含**预构建好的界面**),拷过去解开就能用:

```bash
# 本地
npm pack                       # 得到 mastic-0.1.0.tgz(约 170KB)
scp mastic-0.1.0.tgz 服务器:~/

# 服务器上
tar xzf mastic-0.1.0.tgz && mv package mastic && cd mastic
npm install --omit=dev         # 只装运行时要的:1 个包,1.4MB
cp .env.example .env && vim .env

node bin/mastic.mjs help       # 能跑
```

想做成任意目录都能敲的命令,加个软链:

```bash
ln -s "$PWD/bin/mastic.mjs" ~/.local/bin/mastic
mastic help
```

**别用 `npm install -g` 装。** Node 明确拒绝给 `node_modules` 下的文件擦除类型:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

这个项目靠 Node 直接跑 `.ts`,而那个机制对 `node_modules` 关着门 ——
装进去就起不来。解包到普通目录(外加软链)是正路。

**服务器上必须是 Node ≥ 23.6**,这是硬要求:`node --version` 先看一眼。

`.env` 按**你当前所在的目录**找,不是按包装在哪找 —— 所以在哪个项目里跑
`mastic`,就读哪个项目的 `.env`。

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

`mastic ui` 起一个本地服务(默认 <http://127.0.0.1:7777>)。**命令行能做的,
界面里都能做** —— 不用回到终端。

- **底部输入框**:写下要做的事,回车。planner 拆完任务树,任务就一个一个出现在侧栏。
- **左**:任务侧栏。像文档站的目录 —— 按依赖深度缩进(缩进就是"谁等谁"),
  点一下,中间的内容**滚动到对应那一节**。滚到哪,侧栏就高亮哪。
- **中**:所有任务连成一页,顺着往下读。每节的标题条是吸顶的,所以读到中间
  也知道这一段属于哪个任务。顶部一个总开关切「交付报告 / 任务书」。
  报告里裁定**逐条**列出来,三态各有各的标记:通过、通过但附一句、没通过。
- **右**:实时事件流,SSE 推过来的,一条一条往上长。

**它不会整屏刷新。** 新事件是追加到列表尾部的,已经画好的那些原地不动;
新的任务小节第一次出现时播一次入场动画。用户往上翻历史时,自动跟随会停住,
不会被拽回底部。

所以你可以开着界面跑,同时干别的 —— 它会一直往下长。

因为文档 schema 是严格的,前端解析不需要任何启发式:状态、判据、证据
都是 frontmatter 里的字段,不是从正文里猜出来的。

### 界面能发起的操作

| 操作 | 接口 |
| --- | --- |
| 新建运行 | `POST /api/runs` `{goal}` → `{runId}` |
| 列出运行 | `GET /api/runs` |
| 取一次运行的文档 | `GET /api/runs/:id` |
| 订阅事件流 | `GET /api/runs/:id/events`(SSE) |
| 取消运行 | `POST /api/runs/:id/cancel` |
| 看 / 切工作区 | `GET /api/workspaces` · `POST /api/workspace` `{path}` |
| 取运行里的附图 | `GET /api/runs/:id/attachments/:name` |

取消**只在任务边界生效** —— 不会打断正在跑的那个,免得在工作区里留下半截改动。

### 带图

输入框左边可以加图片(选择文件、拖进来、或**直接粘贴截图**),最多 4 张、每张 4MB。

图片不是"发过去看一眼就没了" —— 它和任务书、报告一样**落在这次运行的目录里**:

```
.mastic/runs/<id>/attachments/1.png
```

planner 会把它写进任务书的 inputs:

```yaml
inputs:
  - kind: image
    path: attachments/1.png
```

于是两件事成立:**worker 知道要看哪张图**(只有被声明的图才会发过去,图片很贵,
不该无条件塞给每个 worker),**事后翻回来也看得到当时那张图长什么样** ——
任务书里那句"如果图里那个按钮是灰的"才有据可依。

只用 PNG / JPEG / WebP / GIF。**SVG 一定进不来** —— 它能带脚本,放进 data URL
再被浏览器渲染出来就是个 XSS 面。

### 工作区是可以切的

**一次运行只属于一个工作区** —— 报告里的相对路径、引用的文件、下次会改的东西,
都只在那个目录里说得通。所以界面不把所有运行混成一个列表:那样切过去看到的报告
会和顶栏写着的工作区对不上。

顶栏那个路径是个下拉框。切过去之后,运行列表跟着换。用过的会记在
`~/.config/mastic/workspaces.json`(只记路径,不记别的),重开还在。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 必填 | 任何 OpenAI 兼容接口的 key |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | 接口地址 |
| `OPENAI_MODEL` | `deepseek-chat` | 模型名 |
| `MASTIC_WORKSPACE` | 当前目录 | agent 动手的目录 |
| `MASTIC_CONCURRENCY` | `3` | 同时跑几个 worker |
| `MASTIC_MAX_RETRIES` | `2` | 判 contradicted 后最多重派几次 |
| `MASTIC_RUN_BUDGET_STEPS` | `400` | 整次运行的步数总预算 |
| `MASTIC_TASK_STEP_CEILING` | `80` | 单个任务的硬顶 |
| `MASTIC_PLANNER_STEPS` | `40` | planner 最多几步 |
| `MASTIC_COMMAND_TIMEOUT_MS` | `300000` | 验收命令超时 |
| `MASTIC_REQUEST_IDLE_TIMEOUT_MS` | `240000` | 模型流空闲多久判断流(空闲超时,不是总时长) |
| `MASTIC_VISION` | `1` | 模型收不收图。设 0 时界面不显示上传入口 |

## 项目结构

依赖方向是设计的一部分 —— 越靠下的层越纯,底下三层完全不碰模型:

```
src/
  cli.ts            命令入口
  orchestrator.ts   调度:分层、并行、带 findings 重派
  inspect.ts        check / verify 两个只读命令
  server.ts         HTTP:静态产物 + REST + SSE + 从界面发起运行
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

web/                前端(Vite + React,独立于后端那条"直接跑 .ts"的链子)
  src/
    App.tsx         三栏布局、运行状态、发起新运行
    api.ts          服务端形状的类型 + SSE 订阅
    icons.ts        图标的唯一出处(语义名,不直接 import 图标库)
    lib/
      markdown.tsx  Markdown → React 节点(不生成 HTML 字符串)
      graph.ts      任务树分层(界面用)
      status.ts     状态词汇表:颜色和图标只有一个出处
    components/
      TaskSidebar.tsx  任务侧栏(按依赖深度缩进,点击跳转)
      TaskSection.tsx  长页里的一个任务小节(带锚点)
      DocumentView.tsx 任务书 / 交付报告
      EventStream.tsx  实时事件流
      Composer.tsx     输入需求的框
  dist/             构建产物(npm install 时自动生成,不入库)

test/               后端用例:node --test,全部离线
```

**后端和前端用的是两条不同的链子。** 后端靠 Node 直接擦除类型跑 `.ts`,
不沾任何构建工具 —— 这是刻意的,它保证了 `mastic` 在最朴素的环境里也能跑。
前端要 JSX,只能交给 Vite。两条链子各测各的,互不牵连。

## 测试

```bash
npm test               # 后端(node --test)+ 前端(vitest),全部离线
npm run test:core      # 只跑后端
npm run test:web       # 只跑前端
npm run typecheck      # tsc,两个项目都查
```

覆盖的是**不需要 API key 的那部分** —— 也就是真正承载项目主张的那部分:

- 文档 schema:没证据的 claim 收不下、空判据的验收收不下、越界路径挡得住
- 证据重放:**编造的哈希判 contradicted**,而带时间戳的老实证据只判 drifted
- 工具循环:交卷打回、卡住判定、**步数用尽强制交卷**
- 禁词 lint:中文英文都抓得到,`allow_terms` 是唯一出口,引用不算主张
- 裁定:含"worker 主动喊停 → blocked,即使别的都过了"
- 并发闸门:同时最多跑 limit 个、某个抛错不会被吞掉
- 前端:Markdown 渲染**不生成 HTML 字符串**(XSS 在结构上不成立)、
  裁定三态各有各的颜色、任务小节带得着可跳转的锚点、侧栏分层正确

## 设计取舍

**为什么证据要重放两次。** 一次重放分不清"命令本身不稳定"和"这个哈希是编的"。
第二次重跑是判别实验:稳定性是可观测的,编造因此无处藏身。

**已知边界:重放分不清"工作区变了"和"数字是编的"。** 命令现在稳定、记录却对不上时,
两种可能都说得通。真实例子:worker 记了 `ls -R src`,然后自己往 `src` 下建了文件,
重放自然对不上。裁定仍然拦下它(这条证据确实不能作数,会重做),但**措辞不断言说谎**
—— 分不清的事就不装作分得清。要避开这一类,证据就别用依赖可变状态的命令
(列目录、`git status`、目录树),用文件内容哈希。

**为什么 `unverified` 是合法终态。** agent 会说谎,是因为 schema 逼着它把结论填满。
给它一个体面的"我不知道",它才不需要编。

**为什么老实交代不该掉分。** 这一条是被真实运行纠正过来的。原先只要报告里
列了 `unresolved`、或者有任何一条证据输出漂移,整个任务就降到 `unverified`。
结果:一个 14 条判据全过、却主动写下「我没法用哈希证明我没改测试文件」的 worker,
拿到的评价比什么都不说的低。**系统惩罚了它最想要的那个行为** —— 理性的 agent
学到的就是少说话,而这跟本项目的立意正好相反。

现在这两样都只是披露:`unresolved` 照常渲染给人看,漂移在判据里标 ⚠,
两者都不改状态。代价是 `unverified` 变得少见(它现在只表示"有证据根本没法验"),
但换来的是**诚实不再有代价**,以及 `verified` 重新可达 —— 在那之前,
任何靠测试命令验收的任务永远拿不到它,这个状态也就不携带信息了。

**为什么漂移不降级而编造仍然致命。** 判别实验分得很清楚:两次新跑互不相同,
是命令本身在抖;两次新跑一致却和记录对不上,才是记录站不住。前者是抄件的性质,
后者是 `contradicted`。所以放宽漂移不会给编造开口子。

**为什么步数用尽后还要再给一轮。** 一开始不是这样的:步数用尽就直接判失败,
重试从头再来一遍 —— 于是同一个任务每次都卡在同样的步数上,永远做不完,
而已经做的工作全丢了。现在用尽步数会强制交卷:做成什么写什么,没做完的
写进 `unresolved`。**交一份不完整的报告是可以接受的;什么都不交不可以。**
(这是实测出来的:自举任务在真实仓库里光读文件就花掉了二十多步。)

**为什么禁词表里没有 TODO / FIXME。** 那不是"在编",是"没写完"。
而且 `node --test` 的输出里天然有一行 `ℹ todo 0`,放进禁词表必然误伤每一份老实报告。

**前端为什么最后还是上了构建步骤。** 第一版是没有的:三个文件,浏览器直接
加载,靠一个手写的 DOM 替身来测。那套确实轻,但它有个看得见的代价 ——
**图形那块全是手搓的**:分层是自己算的,连线是自己画的贝塞尔曲线,
样式是一条一条 CSS。做到第三个面板时,时间花在重造轮子上而不是界面上。

换到 Vite + React 之后,布局和状态不再手搓,代价是诚实的:多了构建链、
前端测试要换一套跑法、`npm install` 慢了一点(约 0.3 秒)。

后端那条"直接跑 `.ts`、不沾构建工具"的链子没有动 —— 那个性质值得保,
因为它保证了 `mastic` 在最朴素的环境里也能跑起来。

**为什么任务树最后不是一张图谱。** 第一版用的是 React Flow 画布,理由是
"多 agent 跑起来好看"。实际用下来它不称手:**画布擅长看关系,不擅长读内容**。
点一个节点,中间整块被换掉,看不到全局,也没法顺着往下读;任务一多还要
自己拖来拖去。

现在换成文档站的侧栏:任务按依赖深度缩进,点一下内容滚到对应那一节。
依赖关系仍然看得出来(缩进 = 谁等谁),但主要用途从"看关系"变成了"读内容"。
顺带把 React Flow 这个依赖去掉了,包从 135KB(gzip)降到 77KB。

教训是:**"可视化"和"可读"是两件事**,我当时按前者选了工具,而实际要的是后者。

**为什么图标不直接 import 图标库。** 所有图标都从 `web/src/icons.ts` 出,
而且用的是**语义名**(`CheckCaveatIcon` 而不是 `AlertTriangle`)。
组件里说的是"这里要表示'通过了但有话要说'",不是"这里要一个三角形"。
换整套图标只改这一个文件。另外:不用 emoji 和 `✓ ✗` 这类字符当图标 ——
它们在不同平台的字形、基线、颜色都不一样,凑在一起很脏。

## 许可

MIT
