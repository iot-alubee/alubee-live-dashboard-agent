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
let filtersReady = false;

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

function fillSelect(sel, options, selected, includeAll) {
  const vals = includeAll ? ["All", ...options.filter((o) => o !== "All")] : options.slice();
  let prev = selected;
  if (!vals.includes(prev)) {
    prev = includeAll ? "All" : vals[0] || "";
  }
  sel.innerHTML = vals
    .map((v) => `<option value="${esc(v)}"${v === prev ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
  sel.value = prev;
  return prev;
}

function cascadeSupervisors(filterMeta) {
  const dept = filterState.department;
  const byDept = filterMeta?.supervisors_by_department || {};
  if (dept && byDept[dept]?.length) return byDept[dept];
  return filterMeta?.supervisors || [];
}

function supervisorsInSnapshot(machines) {
  return [
    ...new Set(
      (machines || [])
        .map((m) => String(m.Supervisor || "").trim())
        .filter((s) => s && s !== "—" && s !== "-")
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function setupFilters(filterMeta) {
  if (!filterMeta) return;
  const departments = filterMeta.departments || [];
  const statuses = filterMeta.statuses || ["All", "Running", "Idle", "Disconnected", "Reset"];
  const snapshotSups = supervisorsInSnapshot(latestData?.machines);

  if (!filtersReady) {
    filterState.department = departments[0] || "";
    const cascaded = cascadeSupervisors(filterMeta);
    filterState.supervisor =
      cascaded.find((s) => snapshotSups.includes(s)) ||
      snapshotSups[0] ||
      cascaded[0] ||
      "";
    filterState.status = "All";
    filtersReady = true;
  }

  if (departments.length && !departments.includes(filterState.department)) {
    filterState.department = departments[0];
  }

  filterState.department = fillSelect(
    filterDepartment,
    departments,
    filterState.department,
    false
  );

  const supervisors = cascadeSupervisors(filterMeta);
  if (supervisors.length && !supervisors.includes(filterState.supervisor)) {
    filterState.supervisor = supervisors[0];
  }
  filterState.supervisor = fillSelect(
    filterSupervisor,
    supervisors,
    filterState.supervisor,
    false
  );
  filterState.status = fillSelect(filterStatus, statuses, filterState.status, true);

  if (filterHint && !latestData?.message) {
    const swap = filterMeta.supervisor_swapped
      ? "Supervisors swapped this week"
      : "Base supervisor week";
    filterHint.textContent = swap;
  }
}

function rowMatches(r) {
  if (filterState.department && r.Department !== filterState.department) return false;
  if (filterState.supervisor && r.Supervisor !== filterState.supervisor) return false;
  if (filterState.status !== "All" && r.Status !== filterState.status) return false;
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
    backgroundColor: "rgba(251, 191, 36, 0.15)",
    borderWidth: 2.5,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointBackgroundColor: "#fde68a",
    pointBorderColor: "#fbbf24",
    pointBorderWidth: 2,
    tension: 0.3,
    fill: false,
    order: 1,
    yAxisID: "yLine",
  };
  return { datasets: [...bars, line], yMax };
}

function liveChartOptions(yMax) {
  const c = typeof window.getDashboardChartColors === "function"
    ? window.getDashboardChartColors()
    : {
        tick: "#bae6fd",
        grid: "rgba(76, 201, 240, 0.1)",
        axisTitle: "#7dd3fc",
        legend: "#e0f2fe",
        tooltipBg: "rgba(13, 27, 42, 0.95)",
        tooltipTitle: "#4cc9f0",
        tooltipBody: "#e8f4ff",
        tooltipBorder: "rgba(76, 201, 240, 0.35)",
      };
  return {
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
        labels: {
          color: c.legend,
          font: { family: "Montserrat", size: 11, weight: "600" },
          boxWidth: 12,
          padding: 14,
        },
      },
      tooltip: {
        mode: "index",
        intersect: false,
        backgroundColor: c.tooltipBg,
        titleColor: c.tooltipTitle,
        bodyColor: c.tooltipBody,
        borderColor: c.tooltipBorder,
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { color: c.tick, maxRotation: 25, minRotation: 0, autoSkip: true },
        grid: { color: c.grid },
        title: { display: true, text: "Time Bucket", color: c.axisTitle, font: { weight: "600" } },
      },
      y: {
        stacked: true,
        beginAtZero: true,
        max: yMax,
        ticks: { color: c.tick },
        grid: { color: c.grid },
        title: { display: true, text: "Shots", color: c.axisTitle, font: { weight: "600" } },
      },
      yLine: {
        stacked: false,
        beginAtZero: true,
        max: yMax,
        display: false,
        grid: { drawOnChartArea: false },
      },
    },
  };
}

function applyLiveChartTheme() {
  if (!shotChart) return;
  const yMax = shotChart.options.scales.y.max;
  shotChart.options = liveChartOptions(yMax);
  shotChart.update("none");
}

function renderChart(chart) {
  const canvas = document.getElementById("shot-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const labels = (chart && chart.labels) || [];
  const rawDatasets = (chart && chart.datasets) || [];
  const hasData =
    labels.length > 0 &&
    rawDatasets.some((ds) => (ds.data || []).some((v) => Number(v) > 0));

  if (!hasData) {
    canvas.classList.add("hidden");
    if (chartEmpty) chartEmpty.classList.remove("hidden");
    if (shotChart) {
      shotChart.destroy();
      shotChart = null;
    }
    return;
  }

  canvas.classList.remove("hidden");
  if (chartEmpty) chartEmpty.classList.add("hidden");

  const { datasets, yMax } = withTotalsLine(labels, rawDatasets);
  const ctx = canvas.getContext("2d");
  if (shotChart) {
    shotChart.data.labels = labels;
    shotChart.data.datasets = datasets;
    shotChart.options = liveChartOptions(yMax);
    shotChart.update("none");
    requestAnimationFrame(() => shotChart.resize());
    return;
  }
  shotChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: liveChartOptions(yMax),
  });
  requestAnimationFrame(() => shotChart.resize());
}

function syncFilterStateFromDom() {
  if (filterDepartment) filterState.department = filterDepartment.value;
  if (filterSupervisor) filterState.supervisor = filterSupervisor.value;
  if (filterStatus) filterState.status = filterStatus.value || "All";
}

function applyAndRender(rebuildFilters = false) {
  if (!latestData) return;
  const all = latestData.machines || [];
  if (rebuildFilters) setupFilters(latestData.filters);
  syncFilterStateFromDom();
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
      if (!set.size) return false;
      if (filterState.department && r.Department !== filterState.department) return false;
      if (filterState.supervisor && r.Supervisor !== filterState.supervisor) return false;
      return set.has(r["Machine No"]);
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
    const prevUnit = latestData?.unit_id;
    const prevShift = latestData?.shift_name;
    latestData = data;
    shiftEl.textContent = `${data.shift_name || "—"} · ${data.shift_range || ""}`.trim();
    if (filterHint) {
      filterHint.textContent = data.message
        ? data.message
        : data.filters?.supervisor_swapped
        ? "Supervisors swapped this week"
        : "Base supervisor week";
    }
    const rebuildFilters =
      !filtersReady ||
      !prevUnit ||
      prevUnit !== data.unit_id ||
      prevShift !== data.shift_name;
    applyAndRender(rebuildFilters);
    updateServerStatus(data);
  } catch (err) {
    console.error(err);
    if (filterHint) filterHint.textContent = "Error: " + err.message;
    updateServerStatus(null);
  } finally {
    refreshInFlight = false;
  }
}

[filterDepartment, filterSupervisor, filterStatus].forEach((el) => {
  if (el)
    el.addEventListener("change", (ev) => {
      syncFilterStateFromDom();
      if (ev.target === filterDepartment && latestData?.filters) {
        setupFilters(latestData.filters);
        syncFilterStateFromDom();
      }
      applyAndRender(false);
    });
});

function selectUnit(unitId) {
  currentUnit = unitId;
  document.querySelectorAll(".tab-btn[data-unit]").forEach((b) => {
    b.classList.toggle("active", b.dataset.unit === unitId);
  });
  const histUnit = document.getElementById("hist-unit");
  if (histUnit) histUnit.value = unitId;
  filtersReady = false;
  filterState.department = "";
  filterState.supervisor = "";
  filterState.status = "All";
  if (document.getElementById("tab-live")?.classList.contains("active")) {
    refreshSnapshot();
  } else if (typeof window.onHistoryUnitChange === "function") {
    window.onHistoryUnitChange(unitId);
  }
}

document.querySelectorAll(".tab-btn[data-unit]").forEach((btn) => {
  btn.addEventListener("click", () => selectUnit(btn.dataset.unit));
});

window.setLiveUnit = selectUnit;
window.resizeLiveChart = function () {
  if (shotChart) shotChart.resize();
};

tickClock();
setInterval(tickClock, CLOCK_MS);
window.refreshLiveSnapshot = refreshSnapshot;
refreshSnapshot();
setInterval(refreshSnapshot, SNAPSHOT_MS);
