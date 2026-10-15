export const state = {
  runId: null,
  run: null,
  tasks: [],
  reports: [],
  selected: null,
  view: "report",
};

const STATUS_ORDER = ["verified", "unverified", "contradicted", "blocked", "failed", "skipped", "running", "pending"];

const STATUS_LABEL = {
  verified: "已验证",
  unverified: "未验全",
  contradicted: "对不上",
  blocked: "卡住",
  failed: "没交卷",
  skipped: "跳过了",
  running: "在跑",
  pending: "待跑",
};

/* ── 文本工具 ─────────────────────────────────────────────── */

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 极简 Markdown 渲染。
 *
 * 顺序要紧:**先转义,再做标记替换**。内容全部来自模型,反过来做就等于
 * 把 XSS 入口敞开。
 *
 * 代码块先摘出来占位,免得块里的 `#`、`*` 被当成标题和强调。
 */
export function renderMarkdown(source) {
  const blocks = [];
  let text = String(source ?? "");

  text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(code);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  const lines = text.split("\n");
  const out = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`);
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();

  return out
    .join("\n")
    .replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => `<pre><code>${escapeHtml(blocks[Number(index)])}</code></pre>`);
}

/**
 * 行内标记。
 *
 * 行内代码也得先摘出来:否则 `` `a **b** c` `` 会先变成 `<code>a **b** c</code>`,
 * 紧接着那个 `**b**` 又被强调规则捞走,把代码里的内容改掉。
 * 传进来的 text 已经转义过,所以摘出来的片段原样放回即可。
 */
function inline(text) {
  const codes = [];

  const out = text
    .replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000IC${codes.length - 1}\u0000`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return out.replace(/\u0000IC(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

function statusRank(status) {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}

/* ── 数据 ─────────────────────────────────────────────────── */

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return await response.json();
}

function taskStatus(id) {
  const report = state.reports.find((entry) => entry.doc?.data?.task === id);
  return report?.doc?.data?.status ?? "pending";
}

/** 任务书里的 depends_on 决定层级,同层横排。 */
export function layout(meta) {
  const ids = meta.map((data) => data.id).filter(Boolean);
  const remaining = new Set(ids);
  const layers = [];

  while (remaining.size > 0) {
    const layer = meta.filter(
      (data) => remaining.has(data.id) && (data.depends_on ?? []).every((dep) => !remaining.has(dep)),
    );
    if (layer.length === 0) break;
    for (const data of layer) remaining.delete(data.id);
    layers.push(layer);
  }

  // 有环时剩下的一股脑丢最后一层,别让界面空着
  if (remaining.size > 0) layers.push(meta.filter((data) => remaining.has(data.id)));

  return layers;
}

/* ── 渲染:任务树 ─────────────────────────────────────────── */

export function renderDag() {
  const container = document.getElementById("dag");
  container.innerHTML = "";

  if (state.tasks.length === 0) {
    container.innerHTML = '<p class="empty">这次运行还没有任务书。</p>';
    return;
  }

  const layers = layout(state.tasks.map((entry) => entry.doc?.data ?? {}));
  const columnWidth = 190;
  const rowHeight = 84;
  const width = Math.max(layers.length * columnWidth, 200);
  const height = Math.max(...layers.map((layer) => layer.length)) * rowHeight + 20;

  const positions = new Map();
  layers.forEach((layer, column) => {
    layer.forEach((data, row) => {
      positions.set(data.id, { x: column * columnWidth + 12, y: row * rowHeight + 14 });
    });
  });

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.classList.add("edges");

  for (const data of state.tasks.map((entry) => entry.doc?.data ?? {})) {
    for (const dep of data.depends_on ?? []) {
      const from = positions.get(dep);
      const to = positions.get(data.id);
      if (!from || !to) continue;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const x1 = from.x + 160;
      const y1 = from.y + 26;
      const x2 = to.x;
      const y2 = to.y + 26;
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 22} ${y1}, ${x2 - 22} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", "edge");
      svg.append(path);
    }
  }

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.append(svg);

  for (const [id, position] of positions) {
    const status = taskStatus(id);
    const node = document.createElement("button");
    node.className = `node status-${status}${state.selected === id ? " is-selected" : ""}`;
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    node.innerHTML =
      `<span class="node-id">${escapeHtml(id)}</span>` +
      `<span class="node-status">${STATUS_LABEL[status] ?? status}</span>`;

    node.addEventListener("click", () => {
      state.selected = id;
      renderDag();
      renderDoc();
    });

    stage.append(node);
  }

  container.append(stage);
  renderLegend();
}

function renderLegend() {
  const counts = new Map();
  for (const data of state.tasks.map((entry) => entry.doc?.data ?? {})) {
    if (!data.id) continue;
    const status = taskStatus(data.id);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  document.getElementById("legend").innerHTML = [...counts.entries()]
    .sort((a, b) => statusRank(a[0]) - statusRank(b[0]))
    .map(
      ([status, count]) =>
        `<span class="legend-item"><i class="swatch status-${status}"></i>${STATUS_LABEL[status] ?? status} ${count}</span>`,
    )
    .join("");
}

/* ── 渲染:文档 ───────────────────────────────────────────── */

function field(label, value) {
  return `<div class="field"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function renderAcceptance(taskData) {
  const checks = (taskData.acceptance ?? [])
    .map((check) => {
      if (check.kind === "command") {
        return `<li><code>${escapeHtml(check.run)}</code><span class="tag">command</span></li>`;
      }
      if (check.kind === "structural") {
        return `<li>${escapeHtml((check.require ?? []).join(", "))}<span class="tag">structural</span></li>`;
      }
      return `<li>${escapeHtml(check.statement)}<span class="tag">statement</span></li>`;
    })
    .join("");
  return `<ul class="acceptance">${checks}</ul>`;
}

function renderVerdict(reportData) {
  const verdict = reportData.verdict;
  if (!verdict) return '<p class="empty">还没裁定。</p>';

  const checks = (verdict.checks ?? [])
    .map(
      (check) =>
        `<li class="${check.passed ? "pass" : "fail"}">` +
        `<span class="mark">${check.passed ? "✓" : "✗"}</span>` +
        `<span class="check-label">${escapeHtml(check.label)}</span>` +
        `<span class="tag">${escapeHtml(check.kind)}</span>` +
        `<div class="check-detail">${escapeHtml(check.detail)}</div>` +
        `</li>`,
    )
    .join("");

  const reasons = (verdict.reasons ?? [])
    .map((reason) => `<li>${escapeHtml(reason)}</li>`)
    .join("");

  return (
    `<div class="verdict"><h3>裁定</h3><ul class="reasons">${reasons}</ul>` +
    `<h3>判据</h3><ul class="checks">${checks}</ul></div>`
  );
}

function renderClaims(reportData) {
  const claims = reportData.claims ?? [];
  if (claims.length === 0) return "";

  const items = claims
    .map((claim) => {
      const evidence = (claim.evidence ?? [])
        .map((item) => {
          if (item.kind === "command") {
            return `<li><code>${escapeHtml(item.run)}</code><span class="tag">退出码 ${item.exit_code}</span><span class="hash">${escapeHtml(String(item.stdout_sha256 ?? "").slice(0, 12))}…</span></li>`;
          }
          if (item.kind === "file") {
            return `<li><code>${escapeHtml(item.path)}</code><span class="hash">${escapeHtml(String(item.sha256 ?? "").slice(0, 12))}…</span></li>`;
          }
          return `<li><code>${escapeHtml(item.url)}</code></li>`;
        })
        .join("");
      return `<li class="claim"><p>${escapeHtml(claim.statement)}</p><ul class="evidence">${evidence}</ul></li>`;
    })
    .join("");

  return `<div class="claims"><h3>主张与证据</h3><ul>${items}</ul></div>`;
}

export function renderDoc() {
  const container = document.getElementById("doc");
  const id = state.selected;

  if (id === null) {
    container.innerHTML = '<p class="empty">左边点一个任务。</p>';
    return;
  }

  const taskEntry = state.tasks.find((entry) => entry.doc?.data?.id === id);
  const reportEntry = state.reports.find((entry) => entry.doc?.data?.task === id);

  if (state.view === "task") {
    const data = taskEntry?.doc?.data;
    if (!data) {
      container.innerHTML = '<p class="empty">没有这份任务书。</p>';
      return;
    }
    container.innerHTML =
      `<h2>${escapeHtml(data.id)} · ${escapeHtml(data.title ?? "")}</h2>` +
      `<dl class="meta">` +
      field("目标", escapeHtml(data.goal ?? "")) +
      field("依赖", escapeHtml((data.depends_on ?? []).join("、") || "无")) +
      field("交付物", `<code>${escapeHtml(data.deliverable ?? "")}</code>`) +
      field("预算", `${data.budget?.max_steps ?? "?"} 步`) +
      `</dl>` +
      `<h3>验收</h3>${renderAcceptance(data)}` +
      `<article class="body">${renderMarkdown(taskEntry.doc.body)}</article>`;
    return;
  }

  const data = reportEntry?.doc?.data;
  if (!data) {
    container.innerHTML = `<p class="empty">${escapeHtml(id)} 还没有交付报告。</p>`;
    return;
  }

  const unresolved = (data.unresolved ?? []).length
    ? `<h3>未解决</h3><ul class="unresolved">${data.unresolved
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`
    : "";

  const blocked = data.blocked_reason
    ? `<div class="blocked"><strong>卡住</strong>${escapeHtml(data.blocked_reason)}</div>`
    : "";

  const changed = (data.files_changed ?? []).length
    ? `<h3>改动</h3><ul class="changed">${data.files_changed
        .map((item) => `<li><span class="tag">${escapeHtml(item.action)}</span><code>${escapeHtml(item.path)}</code></li>`)
        .join("")}</ul>`
    : "";

  container.innerHTML =
    `<h2>${escapeHtml(id)} · 交付报告</h2>` +
    `<div class="status-line"><span class="pill status-${data.status}">${STATUS_LABEL[data.status] ?? data.status}</span></div>` +
    blocked +
    renderVerdict(data) +
    renderClaims(data) +
    unresolved +
    changed +
    `<article class="body">${renderMarkdown(reportEntry.doc.body)}</article>`;
}

/* ── 渲染:事件流 ─────────────────────────────────────────── */

function appendEvent(event) {
  const list = document.getElementById("events");
  const item = document.createElement("li");
  item.className = `event kind-${event.kind}`;
  item.innerHTML =
    `<span class="time">${escapeHtml((event.at ?? "").slice(11, 19))}</span>` +
    `<span class="who">${escapeHtml(event.task ?? "run")}</span>` +
    `<span class="what">${escapeHtml(event.detail)}</span>`;
  list.append(item);
  list.scrollTop = list.scrollHeight;
}

function subscribe(runId) {
  const list = document.getElementById("events");
  list.innerHTML = "";
  document.getElementById("live-dot").classList.remove("is-live");

  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  source.addEventListener("open", () => document.getElementById("live-dot").classList.add("is-live"));
  source.addEventListener("error", () => document.getElementById("live-dot").classList.remove("is-live"));

  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    appendEvent(event);

    // 任务状态变了就重取一次文档 —— 事件流里只有摘要,文档才是全文
    if (event.kind === "task_verdict" || event.kind === "run_done") {
      void loadRun(state.runId, { keepSelection: true });
    }
  };
}

/* ── 装配 ─────────────────────────────────────────────────── */

async function loadRun(runId, options = {}) {
  const payload = await getJson(`/api/runs/${encodeURIComponent(runId)}`);
  state.runId = runId;
  state.run = payload.run;
  state.tasks = payload.tasks;
  state.reports = payload.reports;

  if (!options.keepSelection || state.selected === null) {
    state.selected = state.tasks[0]?.doc?.data?.id ?? null;
  }

  document.getElementById("run-goal").textContent = state.run?.goal ?? "(没有目标记录)";
  const status = state.run?.status ?? "unknown";
  const pill = document.getElementById("run-status");
  pill.textContent = STATUS_LABEL[status] ?? status;
  pill.className = `pill status-${status}`;

  renderDag();
  renderDoc();
}

async function boot() {
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest(".tab");
    if (!button) return;
    state.view = button.dataset.view;
    for (const tab of document.querySelectorAll(".tab")) {
      tab.classList.toggle("is-active", tab === button);
    }
    renderDoc();
  });

  const { runs, active } = await getJson("/api/runs");
  const picker = document.getElementById("run-picker");

  picker.innerHTML = runs
    .map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id)}</option>`)
    .join("");

  picker.addEventListener("change", () => {
    void loadRun(picker.value);
    subscribe(picker.value);
  });

  const selected = active ?? runs[0]?.id;
  if (!selected) {
    document.getElementById("run-goal").textContent = "还没有任何运行。先跑一次 mastic run。";
    return;
  }

  picker.value = selected;
  await loadRun(selected);
  subscribe(selected);
}

// 让这个文件能被 Node 直接 import 来测那几个纯函数 —— 测试环境里没有 document
if (typeof document !== "undefined") {
  boot().catch((error) => {
    document.getElementById("run-goal").textContent = `载入失败:${error.message}`;
  });
}
