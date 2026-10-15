import type { DocEntry, Evidence, ReportData, TaskData } from "../api";
import { CheckCaveatIcon, CheckFailedIcon, CheckPassedIcon, DocumentIcon, ReportIcon, TaskIcon } from "../icons";
import { Markdown } from "../lib/markdown";
import { StatusBadge } from "./StatusBadge";

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
    <h3 className="mt-6 mb-2 text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">{children}</h3>
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
  if (verdict === undefined) {
    return <p className="text-[13px] text-faint">还没有裁定。</p>;
  }

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
                className={`mt-0.5 text-[12px] leading-relaxed ${check.caveat === true ? "text-unverified" : "text-faint"}`}
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
 * 命令证据也要带上哈希前几位 —— 那是"这条证据可以被重放核对"的凭据,
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

export interface DocumentViewProps {
  task: DocEntry<TaskData> | undefined;
  report: DocEntry<ReportData> | undefined;
  view: "report" | "task";
  onView: (view: "report" | "task") => void;
}

export function DocumentView({ task, report, view, onView }: DocumentViewProps) {
  const taskData = task?.doc?.data ?? null;
  const reportData = report?.doc?.data ?? null;
  const title = taskData?.id ?? reportData?.task ?? null;

  if (title === null) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-faint">
        左边点一个任务。
      </div>
    );
  }

  const tabClass = (active: boolean): string =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors ${
      active ? "bg-slate-100 font-medium text-slate-900" : "text-muted hover:text-slate-900"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="font-mono text-[13px] font-semibold text-slate-900">{title}</span>
        {reportData !== null && <StatusBadge status={reportData.status} />}
        <div className="ml-auto flex gap-1">
          <button className={tabClass(view === "report")} onClick={() => onView("report")}>
            <ReportIcon size={13} />
            交付报告
          </button>
          <button className={tabClass(view === "task")} onClick={() => onView("task")}>
            <TaskIcon size={13} />
            任务书
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {view === "task" ? (
          taskData === null ? (
            <p className="text-[13px] text-faint">没有这份任务书。</p>
          ) : (
            <>
              {taskData.title !== undefined && (
                <p className="text-[15px] font-medium text-slate-900">{taskData.title}</p>
              )}
              {taskData.goal !== undefined && (
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{taskData.goal}</p>
              )}
              <SectionTitle>验收</SectionTitle>
              <AcceptanceList task={taskData} />
              {task?.doc !== null && task?.doc !== undefined && task.doc.body !== "" && (
                <>
                  <SectionTitle>正文</SectionTitle>
                  <Markdown source={task.doc.body} />
                </>
              )}
            </>
          )
        ) : reportData === null ? (
          <div className="flex flex-col items-center gap-2 py-10 text-faint">
            <DocumentIcon size={20} />
            <p className="text-[13px]">{title} 还没有交付报告。</p>
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

            {report?.doc !== null && report?.doc !== undefined && report.doc.body !== "" && (
              <>
                <SectionTitle>正文</SectionTitle>
                <Markdown source={report.doc.body} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
