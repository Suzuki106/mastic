import type { DocEntry, Evidence, ReportData, TaskData } from "../api";
import { CheckCaveatIcon, CheckFailedIcon, CheckPassedIcon, DocumentIcon } from "../icons";
import { Markdown } from "../lib/markdown";
import { StatusBadge } from "./StatusBadge";

export function anchorId(taskId: string): string {
  return `task-${taskId}`;
}

function CheckMark({ passed, caveat }: { passed: boolean; caveat?: boolean }) {
  if (caveat === true) {
    return <CheckCaveatIcon size={14} className="mt-[3px] shrink-0 text-unverified" />;
  }
  return passed ? (
    <CheckPassedIcon size={14} className="mt-[3px] shrink-0 text-verified" />
  ) : (
    <CheckFailedIcon size={14} className="mt-[3px] shrink-0 text-contradicted" />
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h4 className="mt-5 mb-2 text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">{children}</h4>
  );
}

function AcceptanceList({ task }: { task: TaskData }) {
  const items = task.acceptance ?? [];
  if (items.length === 0) return <p className="text-[13px] text-faint">这份任务书没有写验收标准。</p>;

  return (
    <ul className="space-y-1.5">
      {items.map((check, index) => (
        <li key={index} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2">
          {check.kind === "command" ? (
            <code className="font-mono text-[12.5px] break-all text-sky-700">{check.run}</code>
          ) : check.kind === "structural" ? (
            <span className="text-[12.5px] text-slate-600">{check.require.join(" · ")}</span>
          ) : check.kind === "reproducible" ? (
            <code className="font-mono text-[12.5px] break-all text-sky-700">
              {check.run}
              <span className="ml-2 text-faint">跑 {check.runs} 遍比对</span>
            </code>
          ) : (
            <span className="text-[12.5px] text-slate-600">{check.statement}</span>
          )}
          <span className="ml-auto shrink-0 rounded border border-line px-1.5 py-px font-mono text-[10px] text-faint">
            {check.kind}
          </span>
        </li>
      ))}
    </ul>
  );
}

function VerdictSection({ report }: { report: ReportData }) {
  const verdict = report.verdict;
  if (verdict === undefined) return <p className="text-[13px] text-faint">还没有裁定。</p>;

  return (
    <div>
      {verdict.reasons.length > 0 && (
        <ul className="mb-3 space-y-1">
          {verdict.reasons.map((reason, index) => (
            <li key={index} className="text-[12.5px] leading-relaxed text-muted">
              {reason}
            </li>
          ))}
        </ul>
      )}

      <ul className="divide-y divide-line">
        {verdict.checks.map((check, index) => (
          <li key={index} className="flex items-start gap-2 py-2">
            <CheckMark passed={check.passed} {...(check.caveat === true ? { caveat: true } : {})} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] break-all text-slate-700">{check.label}</span>
                <span className="shrink-0 rounded border border-line px-1.5 py-px font-mono text-[10px] text-faint">
                  {check.kind}
                </span>
              </div>
              <div
                className={`mt-0.5 text-[12px] leading-relaxed ${
                  check.caveat === true ? "text-unverified" : "text-faint"
                }`}
              >
                {check.detail}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 证据那一行。
 *
 * 命令证据也带上哈希前几位 —— 那是"这条证据可以被重放核对"的凭据,
 * 只写"退出码 0"的话,读者没法区分它和一句口头保证。
 */
function evidenceLabel(evidence: Evidence): string {
  if (evidence.kind === "command") {
    const hash = evidence.stdout_sha256;
    const tail = hash === undefined ? "" : `  ${hash.slice(0, 12)}…`;
    return `${evidence.run ?? ""} → 退出码 ${evidence.exit_code ?? "?"}${tail}`;
  }
  if (evidence.kind === "file") {
    return `${evidence.path ?? ""}  ${(evidence.sha256 ?? "").slice(0, 12)}…`;
  }
  return evidence.url ?? "";
}

function ClaimsSection({ report }: { report: ReportData }) {
  const claims = report.claims ?? [];
  if (claims.length === 0) return null;

  return (
    <ul className="space-y-3">
      {claims.map((claim, index) => (
        <li key={index}>
          <p className="text-[13px] text-slate-800">{claim.statement}</p>
          <ul className="mt-1 space-y-0.5 border-l-2 border-line pl-3">
            {claim.evidence.map((evidence, evidenceIndex) => (
              <li key={evidenceIndex} className="font-mono text-[11.5px] break-all text-faint">
                {evidenceLabel(evidence)}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** 任务书里的图片路径形如 `attachments/1.png`,转成能取到的地址。 */
export function attachmentUrl(runId: string, path: string): string {
  const name = path.replace(/^attachments\//, "");
  return `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(name)}`;
}

export interface TaskSectionProps {
  taskId: string;
  task: DocEntry<TaskData> | undefined;
  report: DocEntry<ReportData> | undefined;
  view: "report" | "task";
  /** 附图要从这次运行的目录里取。 */
  runId: string;
}

/**
 * 一个任务在长页里的一节。
 *
 * 标题条是 sticky 的:顺着往下读的时候,总知道当前这一段属于哪个任务 ——
 * 这正是之前"点一下整个换掉"那种做法给不了的东西。
 */
export function TaskSection({ taskId, task, report, view, runId }: TaskSectionProps) {
  const taskData = task?.doc?.data ?? null;
  const reportData = report?.doc?.data ?? null;

  const images = (taskData?.inputs ?? []).flatMap((input) =>
    input.kind === "image" && input.path !== undefined ? [input.path] : [],
  );

  return (
    <section id={anchorId(taskId)} data-task={taskId} className="scroll-mt-4 border-b border-line last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-white/95 px-5 py-2.5 backdrop-blur">
        <span className="font-mono text-[13px] font-semibold text-slate-900">{taskId}</span>
        {taskData?.title !== undefined && (
          <span className="truncate text-[12.5px] text-muted">{taskData.title}</span>
        )}
        {reportData !== null && <StatusBadge status={reportData.status} />}
      </div>

      <div className="px-5 py-4">
        {view === "task" ? (
          taskData === null ? (
            <p className="text-[13px] text-faint">没有这份任务书。</p>
          ) : (
            <>
              {taskData.goal !== undefined && (
                <p className="text-[13px] leading-relaxed text-muted">{taskData.goal}</p>
              )}
              {(taskData.skills ?? []).length > 0 && (
                <>
                  <SectionTitle>技能</SectionTitle>
                  <ul className="flex flex-wrap gap-1.5">
                    {(taskData.skills ?? []).map((skill) => (
                      <li
                        key={skill}
                        className="rounded-full border border-line bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                      >
                        {skill}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {images.length > 0 && (
                <>
                  <SectionTitle>附图</SectionTitle>
                  <ul className="flex flex-wrap gap-2">
                    {images.map((path) => (
                      <li key={path}>
                        <a href={attachmentUrl(runId, path)} target="_blank" rel="noreferrer">
                          <img
                            src={attachmentUrl(runId, path)}
                            alt="附图"
                            className="max-h-44 rounded-lg border border-line transition-opacity hover:opacity-90"
                          />
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <SectionTitle>验收</SectionTitle>
              <AcceptanceList task={taskData} />
              {task?.doc != null && task.doc.body !== "" && (
                <>
                  <SectionTitle>正文</SectionTitle>
                  <Markdown source={task.doc.body} />
                </>
              )}
            </>
          )
        ) : reportData === null ? (
          <div className="flex items-center gap-2 py-6 text-faint">
            <DocumentIcon size={16} />
            <span className="text-[13px]">还没有交付报告。</span>
          </div>
        ) : (
          <>
            {reportData.blocked_reason !== undefined && (
              <div className="mb-4 rounded-lg border border-blocked/30 bg-blocked/5 px-3 py-2 text-[13px] text-blocked">
                <span className="font-medium">卡住：</span>
                {reportData.blocked_reason}
              </div>
            )}

            <SectionTitle>裁定</SectionTitle>
            <VerdictSection report={reportData} />

            {(reportData.claims ?? []).length > 0 && (
              <>
                <SectionTitle>主张与证据</SectionTitle>
                <ClaimsSection report={reportData} />
              </>
            )}

            {(reportData.unresolved ?? []).length > 0 && (
              <>
                <SectionTitle>未解决</SectionTitle>
                <ul className="space-y-1">
                  {(reportData.unresolved ?? []).map((item, index) => (
                    <li key={index} className="flex gap-2 text-[12.5px] leading-relaxed text-muted">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-unverified" />
                      {item}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {(reportData.files_changed ?? []).length > 0 && (
              <>
                <SectionTitle>改动</SectionTitle>
                <ul className="space-y-1">
                  {(reportData.files_changed ?? []).map((change, index) => (
                    <li key={index} className="flex items-center gap-2 text-[12.5px]">
                      <span className="rounded border border-line px-1.5 py-px font-mono text-[10px] text-faint">
                        {change.action}
                      </span>
                      <code className="font-mono text-slate-600">{change.path}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {report?.doc != null && report.doc.body !== "" && (
              <>
                <SectionTitle>正文</SectionTitle>
                <Markdown source={report.doc.body} />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
