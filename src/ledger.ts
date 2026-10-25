/**
 * 证据台账。
 *
 * 这是「编造的证据过不了」真正的兑现方式:worker **不写哈希**,它只写
 * `ref: C3` 这样的引用,哈希和退出码由 mastic 在执行的那一刻记进台账。
 * 模型手里根本没有可以编造的数字。
 *
 * 台账只在内存里活一轮任务;落盘的是展开后的报告 —— 那里写的是真值。
 */

export interface InputRecord {
  /** 相对工作目录。 */
  path: string;
  sha256: string;
}

export interface CommandRecord {
  /** C1、C2……按执行顺序编号。 */
  id: string;
  run: string;
  /** 相对工作目录。 */
  cwd: string;
  exitCode: number;
  stdoutSha256: string;
  stdoutBytes: number;
  durationMs: number;
  timedOut: boolean;
  /**
   * 执行这条命令之前,worker 已经用 `read_file` 读过哪些文件、当时的哈希。
   *
   * 这不是完整的依赖集(命令可能读它从没 `read_file` 过的文件),但它是
   * mastic **确实看见过**的那部分输入。重放对不上时,拿它做归因:
   * 输入变过,说明工作区变化足以解释差异;输入没变,就更可能是记录不实。
   * 没有这份记录时,那两种可能永远分不清 —— 这是它存在的理由。
   */
  inputs?: InputRecord[];
}

export interface FileRecord {
  /** F1、F2…… */
  id: string;
  /** 相对工作目录。 */
  path: string;
  sha256: string;
  action: "read" | "written";
  /** 只在 action 为 written 时有意义:写之前这文件在不在,决定它是 created 还是 modified。 */
  existed?: boolean;
}

export interface Ledger {
  commands: CommandRecord[];
  files: FileRecord[];
}

export function createLedger(): Ledger {
  return { commands: [], files: [] };
}

export function recordCommand(ledger: Ledger, record: Omit<CommandRecord, "id">): CommandRecord {
  const entry: CommandRecord = { id: `C${ledger.commands.length + 1}`, ...record };
  ledger.commands.push(entry);
  return entry;
}

export function recordFile(ledger: Ledger, record: Omit<FileRecord, "id">): FileRecord {
  const entry: FileRecord = { id: `F${ledger.files.length + 1}`, ...record };
  ledger.files.push(entry);
  return entry;
}

/** 台账里读到过、且没有落在运行目录里的文件 —— 归因重放的输入集。 */
export function readInputs(ledger: Ledger, limit = 12): InputRecord[] {
  const latest = new Map<string, string>();

  for (const file of ledger.files) {
    if (file.action !== "read") continue;
    if (file.path.startsWith(".mastic/")) continue;
    latest.set(file.path, file.sha256);
  }

  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-limit)
    .map(([path, sha256]) => ({ path, sha256 }));
}

export function findCommand(ledger: Ledger, id: string): CommandRecord | undefined {
  return ledger.commands.find((entry) => entry.id === id.toUpperCase());
}

export function findFile(ledger: Ledger, id: string): FileRecord | undefined {
  return ledger.files.find((entry) => entry.id === id.toUpperCase());
}

/**
 * 从台账推出「改了哪些文件」。
 *
 * 不让模型自己列 —— 那是又一个它能编的字段。写没写过文件,台账知道。
 */
export function deriveFilesChanged(ledger: Ledger): { path: string; action: "created" | "modified" }[] {
  const seen = new Set<string>();
  const changes: { path: string; action: "created" | "modified" }[] = [];

  // 倒着走:同一个文件写了多次,以最后一次为准
  for (const entry of [...ledger.files].reverse()) {
    if (entry.action !== "written" || seen.has(entry.path)) continue;
    seen.add(entry.path);
    changes.push({ path: entry.path, action: entry.existed === false ? "created" : "modified" });
  }

  return changes.reverse();
}

/**
 * 给模型看的台账清单。
 *
 * 有了它,worker 才写得出 `ref` —— 否则它只能靠记对话历史来猜编号,
 * 猜错一次就要重来一轮。
 */
export function renderLedger(ledger: Ledger): string {
  if (ledger.commands.length === 0 && ledger.files.length === 0) {
    return "(还没有任何记录 —— 你还没跑过命令,也没读写过文件)";
  }

  const commands = ledger.commands.map(
    (entry) =>
      `  ${entry.id}  \`${entry.run}\`  → 退出码 ${entry.exitCode}` +
      `  (${entry.durationMs}ms,输出 ${entry.stdoutBytes} 字节)`,
  );

  const files = ledger.files.map(
    (entry) => `  ${entry.id}  ${entry.action === "written" ? "写入" : "读取"} \`${entry.path}\``,
  );

  return [
    commands.length > 0 ? `命令:\n${commands.join("\n")}` : "",
    files.length > 0 ? `文件:\n${files.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
