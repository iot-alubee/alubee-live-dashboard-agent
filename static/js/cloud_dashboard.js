/** Cloud Live Monitor — same layout as local; clock live, data every 10s. */
const SNAPSHOT_MS = 10000;
const CLOCK_MS = 1000;
/** Agent interval is 10s — Offline if no snapshot for 20s */
const SERVER_STALE_MS = 20000;

const clockEl = document.getElementById("clock");
const shiftEl = document.getElementById("shift-line");
const resetEl = document.getElementById("reset-line");
const serverWrap = document.getElementById("server-status-wrap");
const serverDot = document.getElementById("server-dot");
const serverText = document.getElementById("server-status-text");
const machinesBody = document.getElementById("machines-body");
const idleHead = document.getElementById("idle-head");
const idleBody = document.getElementById("idle-body");
const chartEmpty = document.getElementById("chart-empty");
const filterDepartment = document.getElementById("filter-department");
const filterSupervisor = document.getElementById("filter-supervisor");
const filterStatus = document.getElementById("filter-status");
const filterHint = document.getElementById("filter-hint");

let currentUnit = "unit_i";
let latestData = null;
let refreshInFlight = false;
let idleColsKey = "";
let shotChart = null;

const filterState = {
  department: "",
  supervisor: "",
  status: "All",
};

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNow() {
  const d = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd} ${mon} ${yyyy} · ${hh}:${mm}:${ss}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Same format as local monitor.format_elapsed */
function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/**
 * Live elapsed from From=HH:MM:SS (plant local time).
 * Browser-only — no API call. Handles overnight (From later than now → yesterday).
 */
function elapsedFrom(fromStr) {
  if (!fromStr || fromStr === "—" || fromStr === "-") return "—";
  const parts = String(fromStr).trim().split(":").map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return "—";
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    parts[0],
    parts[1],
    parts[2] || 0
  );
  // Overnight shift: From is yesterday if it looks "in the future"
  if (start.getTime() > now.getTime() + 2000) {
    start.setDate(start.getDate() - 1);
  }
  return formatElapsed((now.getTime() - start.getTime()) / 1000);
}

function tickElapsed() {
  document.querySelectorAll("[data-idle-from]").forEach((el) => {
    el.textContent = elapsedFrom(el.getAttribute("data-idle-from"));
  });
}

function tickClock() {
  if (clockEl) clockEl.textContent = formatNow();
  tickElapsed();
  if (resetEl) resetEl.textContent = "Next reset in: " + nextResetCountdown();
  updateServerStatus(latestData);
}

function nextResetAt(now) {
  now = now || new Date();
  const candidates = [];
  for (let day = 0; day <= 1; day++) {
    for (const hour of [8, 20]) {
      const d = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + day,
        hour,
        0,
        0,
        0
      );
      if (d.getTime() > now.getTime()) candidates.push(d);
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates[0] || null;
}

function nextResetCountdown(now) {
  now = now || new Date();
  const next = nextResetAt(now);
  if (!next) return "—";
  let sec = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseSnapshotTime(data) {
  if (!data) return null;
  const raw = data.cloud_received_at || data.updated_at || "";
  if (!raw) return null;
  // Agents send UTC like 2026-07-31T10:00:00Z
  const ms = Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + "Z");
  return Number.isFinite(ms) ? ms : null;
}

function updateServerStatus(data) {
  if (!serverWrap || !serverDot || !serverText) return;
  const ts = parseSnapshotTime(data);
  const online =
    !!data &&
    !data.stale &&
    ts != null &&
    Date.now() - ts <= SERVER_STALE_MS;
  serverDot.classList.toggle("online", online);
  serverDot.classList.toggle("offline", !online);
  serverWrap.classList.toggle("is-online", online);
  serverWrap.classList.toggle("is-offline", !online);
  serverText.textContent = online ? "Online" : "Offline";
}

function statusClass(status) {
  const key = String(status || "").toLowerCase();
  if (key === "running") return "badge-running";
  if (key === "idle") return "badge-idle";
  if (key === "without notice") return "badge-without-notice";
  if (key === "disconnected") return "badge-disconnected";
  if (key === "reset") return "badge-reset";
  return "";
}

function effClass(dir) {
  if (dir === "high" || dir === "up") return "eff-high";
  if (dir === "mid" || dir === "same") return "eff-mid";
  if (dir === "low" || dir === "down") return "eff-low";
  return "eff-flat";
}

function uniqueSorted(vals) {
  return [...new Set(vals.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
  );
}

function fillSelect(sel, options, selected, includeAll) {
  const vals = includeAll ? ["All", ...options.filter((o) => o !== "All")] : options.slice();
  let prev = selected;
  if (!vals.includes(prev)) prev = vals[0] || (includeAll ? "All" : "");
  sel.innerHTML = vals
    .map((v) => `<option value="${esc(v)}"${v === prev ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
  sel.value = prev;
  return prev;
}

function setupFilters(machines) {
  const depts = uniqueSorted(machines.map((m) => m.Department));
  filterState.department = fillSelect(filterDepartment, depts, filterState.department, false);

  const sups = uniqueSorted(
    machines
      .filter((m) => !filterState.department || m.Department === filterState.department)
      .map((m) => m.Supervisor)
  );
  filterState.supervisor = fillSelect(filterSupervisor, sups, filterState.supervisor, false);

  const statuses = ["All", "Running", "Idle", "Disconnected", "Reset"];
  filterState.status = fillSelect(filterStatus, statuses, filterState.status, true);
}

function rowMatches(r) {
  if (filterState.department && r.Department !== filterState.department) return false;
  if (filterState.supervisor && r.Supervisor !== filterState.supervisor) return false;
  if (filterState.status && filterState.status !== "All" && r.Status !== filterState.status)
    return false;
  return true;
}

function renderMachines(rows) {
  if (!rows.length) {
    machinesBody.innerHTML =
      '<tr><td colspan="14" class="empty">No machines match the selected filters.</td></tr>';
    return;
  }
  machinesBody.innerHTML = rows
    .map((r) => {
      const badge = statusClass(r.Status);
      return `<tr>
        <td class="machine-no">${esc(r["Machine No"])}</td>
        <td><span class="badge ${badge}">${esc(r.Status)}</span></td>
        <td>${esc(r.Shots)}</td>
        <td>${esc(r.Idle)}</td>
        <td>${esc(r.From)}</td>
        <td class="elapsed-cell" data-idle-from="${esc(r.From)}">${esc(
          elapsedFrom(r.From)
        )}</td>
        <td>${esc(r["Avg Cycle Time"])}</td>
        <td>${esc(r["Expected Qty/Hour"])}</td>
        <td>${esc(r["Actual Qty/Hour"])}</td>
        <td class="${effClass(r.EfficiencyDir)}">${esc(r.Efficiency)}</td>
        <td>${esc(r["Last Updated"])}</td>
        <td>${esc(r["Latest Ping"])}</td>
        <td class="${r["Reset Status"] === "Not cleared" ? "reset-bad" : ""}">${esc(
          r["Reset Status"] || "—"
        )}</td>
        <td>${esc(r.Reconnections)}</td>
      </tr>`;
    })
    .join("");
}

function ensureIdleHeader(cols) {
  const key = (cols || []).join("|");
  if (key === idleColsKey) return;
  idleColsKey = key;
  idleHead.innerHTML =
    "<th>Machine No</th>" + (cols || []).map((c) => `<th>${esc(c)}</th>`).join("");
}

function renderIdle(rows, cols) {
  ensureIdleHeader(cols || []);
  if (!rows || !rows.length) {
    const n = (cols || []).length + 1;
    idleBody.innerHTML = `<tr><td colspan="${
      n || 1
    }" class="empty">No idle history for this filter yet.</td></tr>`;
    return;
  }
  idleBody.innerHTML = rows
    .map((r) => {
      const levels = r._levels || {};
      const cells = (cols || [])
        .map((c) => {
          const lvl = levels[c] || "empty";
          let cls = "idle-ok";
          if (lvl === "empty") cls = "idle-empty";
          else if (c === "Efficiency Loss" && lvl === "loss-bad") cls = "idle-loss-bad";
          else if (c === "Efficiency Loss" && lvl === "loss-ok") cls = "idle-loss-ok";
          return `<td><span class="${cls}">${esc(r[c])}</span></td>`;
        })
        .join("");
      return `<tr><td class="machine-no">${esc(r["Machine No"])}</td>${cells}</tr>`;
    })
    .join("");
}

function withTotalsLine(labels, barDatasets) {
  const bars = (barDatasets || []).map((ds) => ({
    ...ds,
    type: "bar",
    stack: "shots",
    order: 2,
  }));
  const n = (labels || []).length;
  const totals = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const ds of bars) sum += Number((ds.data && ds.data[i]) || 0);
    totals.push(sum);
  }
  const yMax = Math.max(1, ...totals) * 1.08;
  const line = {
    type: "line",
    label: "Total",
    data: totals,
    borderColor: "#fbbf24",
    backgroundColor: "#fbbf24",
    borderWidth: 2.5,
    pointRadius: 3.5,
    pointHoverRadius: 5,
    pointBackgroundColor: "#fde68a",
    pointBorderColor: "#fbbf24",
    tension: 0.25,
    fill: false,
    order: 1,
    yAxisID: "yLine",
  };
  return { datasets: [...bars, line], yMax };
}

function renderChart(chart) {
  const labels = (chart && chart.labels) || [];
  const rawDatasets = (chart && chart.datasets) || [];
  if (!labels.length || !rawDatasets.length) {
    if (chartEmpty) chartEmpty.classList.remove("hidden");
    if (shotChart) {
      shotChart.destroy();
      shotChart = null;
    }
    return;
  }
  if (chartEmpty) chartEmpty.classList.add("hidden");
  const { datasets, yMax } = withTotalsLine(labels, rawDatasets);
  const ctx = document.getElementById("shot-chart").getContext("2d");
  if (shotChart) {
    shotChart.data.labels = labels;
    shotChart.data.datasets = datasets;
    shotChart.options.scales.y.max = yMax;
    shotChart.options.scales.yLine.max = yMax;
    shotChart.update("none");
    return;
  }
  shotChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      datasets: {
        bar: {
          categoryPercentage: 0.65,
          barPercentage: 0.85,
          maxBarThickness: 56,
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: { color: "#edf2f7", font: { family: "Montserrat", size: 11 } },
        },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#d6e4f0", maxRotation: 25, minRotation: 0, autoSkip: true },
          grid: { color: "rgba(157,187,212,0.12)" },
          title: { display: true, text: "Time Bucket", color: "#9dbbd4" },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: yMax,
          ticks: { color: "#d6e4f0" },
          grid: { color: "rgba(157,187,212,0.12)" },
          title: { display: true, text: "Shots", color: "#9dbbd4" },
        },
        yLine: {
          stacked: false,
          beginAtZero: true,
          max: yMax,
          display: false,
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function applyAndRender() {
  if (!latestData) return;
  const all = latestData.machines || [];
  setupFilters(all);
  const machines = all.filter(rowMatches);
  const set = new Set(machines.map((m) => m["Machine No"]));

  document.getElementById("cnt-total").textContent = machines.length;
  document.getElementById("cnt-run").textContent = machines.filter(
    (r) => r.Status === "Running"
  ).length;
  document.getElementById("cnt-idle").textContent = machines.filter(
    (r) => r.Status === "Idle"
  ).length;
  document.getElementById("cnt-disc").textContent = machines.filter(
    (r) => r.Status === "Disconnected"
  ).length;

  renderMachines(machines);

  const idleRows = (latestData.idle_history || [])
    .filter((r) => {
      if (filterState.department && r.Department !== filterState.department) return false;
      if (filterState.supervisor && r.Supervisor !== filterState.supervisor) return false;
      return set.size ? set.has(r["Machine No"]) : true;
    })
    .sort((a, b) =>
      String(a["Machine No"] || "").localeCompare(String(b["Machine No"] || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  renderIdle(idleRows, latestData.idle_columns || []);

  const chart = latestData.chart || { labels: [], datasets: [] };
  const filteredDatasets = (chart.datasets || []).filter(
    (ds) => ds.label !== "Total" && set.has(ds.label)
  );
  renderChart({ labels: chart.labels || [], datasets: filteredDatasets });
}

async function refreshSnapshot() {
  if (!document.getElementById("tab-live")?.classList.contains("active")) return;
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const res = await fetch("/live?unit=" + encodeURIComponent(currentUnit), {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();
    latestData = data;
    shiftEl.textContent = `${data.shift_name || "—"} · ${data.shift_range || ""}`.trim();
    if (filterHint) {
      filterHint.textContent = data.message
        ? data.message
        : "Clock + Elapsed live · data every 10s";
    }
    applyAndRender();
    updateServerStatus(data);
  } catch (err) {
    console.error(err);
    if (filterHint) filterHint.textContent = "Error: " + err.message;
    updateServerStatus(null);
  } finally {
    refreshInFlight = false;
  }
}

window.setLiveUnit = function (unitId) {
  currentUnit = unitId;
  filterState.department = "";
  filterState.supervisor = "";
  filterState.status = "All";
  if (document.getElementById("tab-live")?.classList.contains("active")) {
    refreshSnapshot();
  }
};

[filterDepartment, filterSupervisor, filterStatus].forEach((el) => {
  if (el)
    el.addEventListener("change", () => {
      filterState.department = filterDepartment.value;
      filterState.supervisor = filterSupervisor.value;
      filterState.status = filterStatus.value;
      // Re-cascade supervisors when department changes
      if (el === filterDepartment && latestData) {
        setupFilters(latestData.machines || []);
        filterState.department = filterDepartment.value;
        filterState.supervisor = filterSupervisor.value;
      }
      applyAndRender();
    });
});

tickClock();
setInterval(tickClock, CLOCK_MS);
refreshSnapshot();
setInterval(refreshSnapshot, SNAPSHOT_MS);
