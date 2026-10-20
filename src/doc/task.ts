import { DocError, parseDoc, serialiseDoc } from "./frontmatter.ts";
import {
  describe,
  isRecord,
  readArray,
  readEnum,
  readInt,
  readRecord,
  readString,
  readStringArray,
  type Problems,
} from "./validate.ts";

/**
 * 指标的三级阶梯。
 *
 * 「给一切任务都定出指标」不是靠发明一个万能指标,而是靠逐级下沉 ——
 * 每个任务恰好落在某一级。级别本身就是任务书的一部分,前端据此显示
 * 「这个任务靠跑 X 验」还是「这个任务是一条待证陈述」。
 */
export const CHECK_KINDS = ["command", "structural", "statement", "reproducible"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * command 级验收的判据。至少要写一项 ——
 * 一条不检查任何东西的验收,等于没有验收,比没有更糟(它会假装通过了)。
 */
export interface CommandExpect {
  exit_code?: number;
  stdout_contains?: string;
  stdout_matches?: string;
  stdout_sha256?: string;
}

export interface CommandCheck {
  kind: "command";
  label?: string;
  run: string;
  cwd?: string;
  expect: CommandExpect;
}

/** structural 级的可用规则。都是机械可判的,不含任何语义判断。 */
export const STRUCTURAL_RULES = [
  "evidence_for_every_claim",
  "no_forbidden_words",
  "no_unresolved",
  "deliverable_matches_task",
  "experiment_inputs_traceable",
  "data_dir_untouched",
  "signed_artifacts_unchanged",
] as const;
export type StructuralRule = (typeof STRUCTURAL_RULES)[number];

export interface StructuralCheck {
  kind: "structural";
  require: StructuralRule[];
}

/**
 * reproducible 级:把实验**再做一遍**,比对结果。
 *
 * 这是论文复现真正要的那件事。`command` 级只是"跑一遍看着对",
 * 那证明不了任何可复现性 —— 它只证明这一次跑出来是这个数。
 *
 * `{out}` 会被替换成每次运行各自的输出目录(`repro-1`、`repro-2`……),
 * 所以两次运行不会互相覆盖。
 */
export interface ReproducibleCompare {
  /** 要比的文件,可含 `{out}`。 */
  path: string;
  /** exact 逐字节;numeric 按数值比,允许容差。 */
  mode: "exact" | "numeric";
  /** mode = numeric 时的相对/绝对容差,默认 1e-6。 */
  tolerance?: number;
}

export interface ReproducibleCheck {
  kind: "reproducible";
  label?: string;
  run: string;
  /** 跑几遍,至少 2。 */
  runs: number;
  cwd?: string;
  compare: ReproducibleCompare[];
}

/** statement 级:产物无法机械判定时,退到「一条可证伪的陈述」。 */
export interface StatementCheck {
  kind: "statement";
  statement: string;
}

export type AcceptanceCheck = CommandCheck | StructuralCheck | StatementCheck | ReproducibleCheck;

export interface TaskInput {
  /** image 是用户在界面上传的图,路径相对 run 目录(attachments/ 下)。 */
  kind: "file" | "dir" | "url" | "image";
  path?: string;
  url?: string;
  note?: string;
}

export interface TaskDoc {
  id: string;
  title: string;
  goal: string;
  parent?: string;
  depends_on: string[];
  inputs: TaskInput[];
  /** 交付报告落在 run 目录下的相对路径。 */
  deliverable: string;
  acceptance: AcceptanceCheck[];
  constraints: string[];
  /** 这份任务书里,哪些词不算违规(比如任务本身就是"写一个 mock server")。 */
  allow_terms: string[];
  body: string;
}

export interface TaskParseResult {
  task?: TaskDoc;
  errors: string[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 交付路径必须落在 run 目录内的 reports/ 下 —— 挡掉绝对路径和 `..` 穿越。 */
export function checkDeliverablePath(value: string, errors: Problems): void {
  if (!value.startsWith("reports/") || !value.endsWith(".md")) {
    errors.push(`\`deliverable\` 得形如 \`reports/T-001.md\`,收到 \`${value}\``);
    return;
  }
  if (value.includes("..") || value.startsWith("/")) {
    errors.push(`\`deliverable\` 不能是绝对路径,也不能含 \`..\`,收到 \`${value}\``);
  }
}

function parseExpect(raw: unknown, errors: Problems, where: string): CommandExpect {
  if (raw === undefined || raw === null) {
    errors.push(`${where} 缺 \`expect\` —— 不写判据的验收等于没有验收。`);
    return {};
  }
  if (!isRecord(raw)) {
    errors.push(`${where} 的 \`expect\` 必须是 key: value 块,收到 ${describe(raw)}`);
    return {};
  }

  const expect: CommandExpect = {};

  if (raw.exit_code !== undefined) {
    const code = readInt(raw, "exit_code", errors, 0);
    expect.exit_code = code;
  }
  const contains = readString(raw, "stdout_contains", errors, { required: false });
  if (contains !== undefined) expect.stdout_contains = contains;

  const matches = readString(raw, "stdout_matches", errors, { required: false });
  if (matches !== undefined) {
    expect.stdout_matches = matches;
    // 正则写错的话,验收会在运行期永远失败 —— 提前在这里挡掉
    try {
      new RegExp(matches);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${where} 的 \`stdout_matches\` 不是合法正则:${detail}`);
    }
  }

  const sha = readString(raw, "stdout_sha256", errors, { required: false });
  if (sha !== undefined) expect.stdout_sha256 = sha;

  if (Object.keys(expect).length === 0) {
    errors.push(`${where} 的 \`expect\` 里一项判据都没有(exit_code / stdout_contains / stdout_matches / stdout_sha256)。`);
  }

  return expect;
}

function parseAcceptance(raw: unknown[], errors: Problems): AcceptanceCheck[] {
  return raw.flatMap((item, index): AcceptanceCheck[] => {
    const where = `acceptance[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${where} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const kind = readEnum(item, "kind", errors, CHECK_KINDS);
    if (kind === undefined) return [];

    if (kind === "command") {
      const run = readString(item, "run", errors);
      if (run === undefined) {
        errors.push(`${where} 是 command 级,必须给 \`run\`(要执行的命令)。`);
        return [];
      }
      const check: CommandCheck = {
        kind: "command",
        run,
        expect: parseExpect(item.expect, errors, where),
      };
      const label = readString(item, "label", errors, { required: false });
      if (label !== undefined) check.label = label;
      const cwd = readString(item, "cwd", errors, { required: false });
      if (cwd !== undefined) check.cwd = cwd;
      return [check];
    }

    if (kind === "reproducible") {
      const run = readString(item, "run", errors);
      if (run === undefined) {
        errors.push(`${where} 是 reproducible 级,必须给 \`run\`。`);
        return [];
      }

      if (!run.includes("{out}")) {
        errors.push(
          `${where} 的 \`run\` 里必须有 \`{out}\` —— 两次运行得写到不同目录,` +
            `否则后一次覆盖前一次,比对就成了自己比自己。`,
        );
      }

      const runs = readInt(item, "runs", errors, 2);
      if (runs < 2) {
        errors.push(`${where} 的 \`runs\` 至少是 2 —— 只跑一遍不叫复现。`);
      }

      const compare = readArray(item, "compare", errors, { required: true }).flatMap(
        (raw, index): ReproducibleCompare[] => {
          const at = `${where}.compare[${index}]`;
          if (!isRecord(raw)) {
            errors.push(`${at} 必须是 key: value 块,收到 ${describe(raw)}`);
            return [];
          }
          const path = readString(raw, "path", errors);
          if (path === undefined) return [];
          const mode = readEnum(raw, "mode", errors, ["exact", "numeric"] as const, "exact") ?? "exact";
          const tolerance = readInt(raw, "tolerance", errors, 0);
          return [{
            path,
            mode,
            ...(tolerance > 0 ? { tolerance } : {}),
          }];
        },
      );

      if (compare.length === 0 && !errors.some((e) => e.startsWith(`${where}.compare`))) {
        errors.push(`${where} 的 \`compare\` 是空的 —— 不比东西,怎么知道做出来一样?`);
      }

      const check: ReproducibleCheck = { kind: "reproducible", run, runs, compare };
      const label = readString(item, "label", errors, { required: false });
      if (label !== undefined) check.label = label;
      const cwd = readString(item, "cwd", errors, { required: false });
      if (cwd !== undefined) check.cwd = cwd;
      return [check];
    }

    if (kind === "structural") {
      const require = readStringArray(item, "require", errors, { required: true });
      const rules = require.flatMap((rule) => {
        const match = STRUCTURAL_RULES.find((candidate) => candidate === rule);
        if (match === undefined) {
          errors.push(
            `${where} 的 \`require\` 里有不认识的规则 \`${rule}\`,只能是 ` +
              STRUCTURAL_RULES.map((r) => `\`${r}\``).join(" / "),
          );
          return [];
        }
        return [match];
      });
      return [{ kind: "structural", require: rules }];
    }

    const statement = readString(item, "statement", errors);
    if (statement === undefined) {
      errors.push(`${where} 是 statement 级,必须给 \`statement\`(那条可证伪的陈述)。`);
      return [];
    }
    return [{ kind: "statement", statement }];
  });
}

function parseInputs(raw: unknown[], errors: Problems): TaskInput[] {
  return raw.flatMap((item, index) => {
    const where = `inputs[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where} 必须是 key: value 块,收到 ${describe(item)}`);
      return [];
    }

    const kind = readEnum(item, "kind", errors, ["file", "dir", "url", "image"] as const);
    if (kind === undefined) return [];

    const input: TaskInput = { kind };
    if (kind === "url") {
      const url = readString(item, "url", errors);
      if (url === undefined) {
        errors.push(`${where} 是 url 类型,必须给 \`url\`。`);
        return [];
      }
      input.url = url;
    } else {
      const path = readString(item, "path", errors);
      if (path === undefined) {
        errors.push(`${where} 是 ${kind} 类型,必须给 \`path\`。`);
        return [];
      }
      input.path = path;
    }

    const note = readString(item, "note", errors, { required: false });
    if (note !== undefined) input.note = note;
    return [input];
  });
}

export function parseTaskDoc(raw: string): TaskParseResult {
  let parsed: ReturnType<typeof parseDoc>;
  try {
    parsed = parseDoc(raw);
  } catch (error) {
    if (error instanceof DocError) return { errors: [error.message] };
    throw error;
  }

  const errors: Problems = [];
  const { data } = parsed;

  const id = readString(data, "id", errors);
  if (id !== undefined && !ID_PATTERN.test(id)) {
    errors.push(`\`id\` 只能由字母数字和 \`-\` \`_\` 组成,收到 \`${id}\``);
  }

  const deliverable = readString(data, "deliverable", errors);
  if (deliverable !== undefined) checkDeliverablePath(deliverable, errors);

  const acceptance = parseAcceptance(readArray(data, "acceptance", errors, { required: true }), errors);
  if (acceptance.length === 0 && !errors.some((e) => e.includes("acceptance"))) {
    errors.push("`acceptance` 不能是空列表 —— 没有指标的任务不该被派出去。");
  }

  const task: TaskDoc = {
    id: id ?? "",
    title: readString(data, "title", errors) ?? "",
    goal: readString(data, "goal", errors) ?? "",
    depends_on: readStringArray(data, "depends_on", errors),
    inputs: parseInputs(readArray(data, "inputs", errors), errors),
    deliverable: deliverable ?? "",
    acceptance,
    constraints: readStringArray(data, "constraints", errors),
    allow_terms: readStringArray(data, "allow_terms", errors),
    body: parsed.body,
  };

  const parent = readString(data, "parent", errors, { required: false });
  if (parent !== undefined) task.parent = parent;

  if (errors.length > 0) return { errors };
  return { task, errors: [] };
}

function acceptanceToData(check: AcceptanceCheck): Record<string, unknown> {
  if (check.kind === "command") {
    const data: Record<string, unknown> = { kind: "command", run: check.run, expect: check.expect };
    if (check.label !== undefined) data.label = check.label;
    if (check.cwd !== undefined) data.cwd = check.cwd;
    return data;
  }
  if (check.kind === "structural") {
    return { kind: "structural", require: check.require };
  }
  if (check.kind === "reproducible") {
    const data: Record<string, unknown> = {
      kind: "reproducible",
      run: check.run,
      runs: check.runs,
      compare: check.compare,
    };
    if (check.label !== undefined) data.label = check.label;
    if (check.cwd !== undefined) data.cwd = check.cwd;
    return data;
  }
  return { kind: "statement", statement: check.statement };
}

export function taskToData(task: TaskDoc): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    goal: task.goal,
    depends_on: task.depends_on,
    deliverable: task.deliverable,
    acceptance: task.acceptance.map(acceptanceToData),
  };

  if (task.parent !== undefined) data.parent = task.parent;
  if (task.inputs.length > 0) data.inputs = task.inputs;
  if (task.constraints.length > 0) data.constraints = task.constraints;
  if (task.allow_terms.length > 0) data.allow_terms = task.allow_terms;

  return data;
}

export function renderTaskDoc(task: TaskDoc): string {
  return serialiseDoc(taskToData(task), task.body);
}
