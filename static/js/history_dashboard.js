/** Cloud History dashboard — archived shift CSV analytics */
let histShifts = [];
let histCharts = { idle: null, eff: null, shots: null };
let histLoading = false;
let histProcessing = false;
let histDayCache = null;
let histFilterMeta = null;
let histLastLoaded = null;
let idleMachineRows = [];
let idleMachineCols = [];
let idleMachinePage = 0;
const IDLE_MACHINE_PAGE_SIZE = 6;

function histChartColors() {
  return typeof window.getDashboardChartColors === "function"
    ? window.getDashboardChartColors()
    : {
        tick: "#9dbbd4",
        grid: "rgba(148,183,214,0.15)",
        axisTitle: "#9dbbd4",
        legendAlt: "#e8f4ff",
        datalabel: "#e8f4ff",
      };
}

function idleMachineColumns(idleCols, rows) {
  const skip = new Set(["Efficiency Loss"]);
  const cols = (idleCols || []).filter((c) => !skip.has(c));
  const withData = cols.filter((col) =>
    (rows || []).some((r) => {
      const v = String(r[col] ?? "").trim();
      return v && v !== "-" && v !== "—";
    })
  );
  if (cols.includes("Total Idle") && !withData.includes("Total Idle")) {
    withData.push("Total Idle");
  }
  return withData.length ? withData : cols;
}

const histEls = {
  unit: document.getElementById("hist-unit"),
  date: document.getElementById("hist-date"),
  shift: document.getElementById("hist-shift"),
  department: document.getElementById("hist-department"),
  supervisor: document.getElementById("hist-supervisor"),
  machine: document.getElementById("hist-machine"),
  filter: document.getElementById("hist-filter"),
  clear: document.getElementById("hist-clear"),
  exportBtn: document.getElementById("hist-export"),
  shiftDetail: document.getElementById("hist-shift-detail"),
  loading: document.getElementById("hist-loading"),
  eff: document.getElementById("hist-eff"),
  loss: document.getElementById("hist-loss"),
  shots: document.getElementById("hist-shots"),
  high: document.getElementById("hist-high"),
  low: document.getElementById("hist-low"),
};

function dayCacheKey() {
  const unit = histEls.unit?.value || "unit_i";
  const date = histEls.date?.value || "";
  return `${unit}|${date}`;
}

function showHistLoading(show, message) {
  if (!histEls.loading) return;
  histEls.loading.classList.toggle("hidden", !show);
  histEls.loading.setAttribute("aria-busy", show ? "true" : "false");
  const textEl = histEls.loading.querySelector(".hist-loading-text");
  if (textEl && message) textEl.textContent = message;
}

function invalidateDayCache() {
  histDayCache = null;
  histLastLoaded = null;
}

function setHistMessage(msg) {
  if (histEls.shiftDetail) histEls.shiftDetail.textContent = msg;
}

function shiftLabelFromKey(key) {
  return key === "II" ? "Shift II (20:00–08:00)" : "Shift I (08:00–20:00)";
}

function activeFilterParts() {
  const parts = [];
  if (histEls.department?.value) parts.push(histEls.department.value);
  if (histEls.supervisor?.value) parts.push(histEls.supervisor.value);
  if (histEls.machine?.value) parts.push(histEls.machine.value);
  return parts;
}

function updateShiftDetail(data) {
  if (!histEls.shiftDetail) return;
  if (data) {
    histLastLoaded = data;
    const arch = data.archive || {};
    const filters = activeFilterParts();
    const filterNote = filters.length ? ` · ${filters.join(" · ")}` : "";
    histEls.shiftDetail.textContent = `${data.shift_name || ""} · ${data.shift_range || ""} · ${data.summary?.machines || 0} machines${filterNote} · Archived ${arch.archived_at || "—"}`;
    return;
  }
  const date = histEls.date?.value;
  const shift = histEls.shift?.value || "I";
  if (!date) {
    histEls.shiftDetail.textContent = "—";
    return;
  }
  histEls.shiftDetail.textContent = `${shiftLabelFromKey(shift)} · ${date} · Click Filter to load`;
}

function clearHistFilters() {
  if (histEls.department) histEls.department.value = "";
  if (histEls.supervisor) histEls.supervisor.value = "";
  if (histEls.machine) histEls.machine.value = "";
  refreshHistFilterDropdowns();
  applyLocalFilters();
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportHistCsv() {
  const data = histLastLoaded;
  if (!data?.machines?.length) {
    setHistMessage("No data to export — click Filter first");
    return;
  }

  const idleByMachine = {};
  for (const row of data.idle_history || []) {
    idleByMachine[row["Machine No"]] = row;
  }

  const idleCols = (data.idle_columns || []).filter((c) => c !== "Machine No");
  const headers = [
    "Shift ID",
    "Shift Name",
    "Shift Range",
    "Unit",
    "Machine No",
    "Department",
    "Supervisor",
    "Shots",
    "Avg Cycle Time",
    "Efficiency",
    ...idleCols,
  ];

  const lines = [headers.map(csvEscape).join(",")];
  for (const m of data.machines) {
    const idle = idleByMachine[m["Machine No"]] || {};
    const row = [
      data.shift_id || "",
      data.shift_name || "",
      data.shift_range || "",
      idle.Unit || data.unit_id || "",
      m["Machine No"] ?? "",
      m.Department ?? idle.Department ?? "",
      m.Supervisor ?? idle.Supervisor ?? "",
      m.Shots ?? "",
      m["Avg Cycle Time"] ?? "",
      m.Efficiency ?? "",
      ...idleCols.map((col) => idle[col] ?? m[col] ?? ""),
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const unit = data.unit_id || histEls.unit?.value || "unit";
  const shiftId = (data.shift_id || "shift").replace(/[^\w-]+/g, "_");
  a.href = url;
  a.download = `history_${unit}_${shiftId}_machines.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Local calendar date as YYYY-MM-DD. */
function localDateIso(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Most recently completed shift (Shift I 08–20, Shift II 20–08). */
function defaultPreviousShift() {
  const h = new Date().getHours();
  if (h >= 20) {
    return { date: localDateIso(0), shift: "I" };
  }
  if (h >= 8) {
    return { date: localDateIso(-1), shift: "II" };
  }
  return { date: localDateIso(-1), shift: "I" };
}

function applyDefaultPreviousShift() {
  const { date, shift } = defaultPreviousShift();
  if (histEls.date) {
    histEls.date.max = localDateIso(0);
    histEls.date.value = date;
  }
  if (histEls.shift) histEls.shift.value = shift;
}

function fillHistSelect(el, values, allLabel = "All") {
  if (!el) return "";
  const cur = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>`;
  (values || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  });
  if (cur && [...el.options].some((o) => o.value === cur)) {
    el.value = cur;
    return cur;
  }
  el.value = "";
  return "";
}

function cascadeHistSupervisors() {
  const dept = histEls.department?.value || "";
  const byDept = histFilterMeta?.supervisors_by_department || {};
  if (dept && byDept[dept]?.length) return byDept[dept];
  return histFilterMeta?.supervisors || [];
}

function cascadeHistMachines() {
  const dept = histEls.department?.value || "";
  const sup = histEls.supervisor?.value || "";
  let rows = histFilterMeta?.machines_detail || [];
  if (dept) rows = rows.filter((r) => r.department === dept);
  if (sup) rows = rows.filter((r) => r.supervisor === sup);
  return [...new Set(rows.map((r) => r.machine_no))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function refreshHistFilterDropdowns() {
  if (!histFilterMeta) return;
  fillHistSelect(histEls.department, histFilterMeta.departments);
  fillHistSelect(histEls.supervisor, cascadeHistSupervisors());
  fillHistSelect(histEls.machine, cascadeHistMachines());
}

async function loadHistFilterMeta() {
  const unit = histEls.unit?.value || "unit_i";
  const date = histEls.date?.value;
  const shift = histEls.shift?.value || "I";
  if (!date) return;
  try {
    const params = new URLSearchParams({ unit, date, shift });
    const res = await fetch(`/api/history/filters?${params}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Failed to load filters");
    histFilterMeta = data.filters || null;
    refreshHistFilterDropdowns();
  } catch (e) {
    if (histEls.shiftDetail) histEls.shiftDetail.textContent = "Error loading filters: " + e.message;
  }
}

function setHistFilterMeta(filters) {
  histFilterMeta = filters || null;
  refreshHistFilterDropdowns();
}

async function loadShiftList() {
  const unit = histEls.unit?.value || "unit_i";
  try {
    const res = await fetch(`/api/history/shifts?unit=${encodeURIComponent(unit)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load shifts");
    histShifts = data.shifts || [];
  } catch (e) {
    setHistMessage("Error: " + e.message);
  }
}

function destroyChart(key) {
  if (histCharts[key]) {
    histCharts[key].destroy();
    histCharts[key] = null;
  }
}

function sumValues(values) {
  return (values || []).reduce((acc, v) => acc + Number(v || 0), 0);
}

function withTotalsLine(labels, barDatasets) {
  const bars = (barDatasets || [])
    .filter((ds) => ds.label !== "Total")
    .map((ds) => ({
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

function pctOf(value, total, digits = 1) {
  if (!total || !value) return "0.0";
  return ((Number(value) / total) * 100).toFixed(digits);
}

function histLegendWithPct(chart) {
  const ds = chart.data.datasets[0];
  if (!ds) return [];
  const labels = chart.data.labels || [];
  const data = ds.data || [];
  const colors = ds.backgroundColor || [];
  const total = sumValues(data);
  const legendColor = histChartColors().legendAlt;
  return labels
    .map((label, i) => {
      const value = Number(data[i] || 0);
      const color = Array.isArray(colors) ? colors[i % colors.length] : colors;
      return {
        text: `${label} (${pctOf(value, total)}%)`,
        fillStyle: color,
        strokeStyle: color,
        fontColor: legendColor,
        lineWidth: 0,
        hidden: !chart.getDataVisibility(i),
        index: i,
        datasetIndex: 0,
        _sortValue: value,
      };
    })
    .sort((a, b) => b._sortValue - a._sortValue)
    .map(({ _sortValue, ...item }) => item);
}

function renderHistChart(canvasId, emptyId, key, config) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  if (!canvas) return;
  const hasData = config?.data?.datasets?.some((ds) => (ds.data || []).some((v) => v > 0));
  if (!hasData) {
    destroyChart(key);
    canvas.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
    return;
  }
  canvas.classList.remove("hidden");
  if (empty) empty.classList.add("hidden");
  destroyChart(key);
  const chartConfig = { ...config };
  if (chartConfig.options?.plugins?.datalabels && typeof ChartDataLabels !== "undefined") {
    chartConfig.plugins = [ChartDataLabels];
  }
  histCharts[key] = new Chart(canvas, chartConfig);
}

function renderIdleByMachinePage() {
  const table = document.getElementById("hist-idle-machine-table");
  const head = document.getElementById("hist-idle-machine-head");
  const body = document.getElementById("hist-idle-machine-body");
  const pageInfo = document.getElementById("hist-idle-page-info");
  const prevBtn = document.getElementById("hist-idle-prev");
  const nextBtn = document.getElementById("hist-idle-next");
  if (!head || !body || !table) return;

  const cols = ["Machine No", ...idleMachineCols];

  let colgroup = table.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.insertBefore(colgroup, table.firstChild);
  }
  colgroup.innerHTML = cols
    .map((c, i) => {
      const cls =
        i === 0 ? "col-machine" : c === "Total Idle" ? "col-total" : "col-idle";
      return `<col class="${cls}">`;
    })
    .join("");

  head.innerHTML = cols.map((c) => `<th>${esc(c)}</th>`).join("");

  const total = idleMachineRows.length;
  const totalPages = Math.max(1, Math.ceil(total / IDLE_MACHINE_PAGE_SIZE));
  if (idleMachinePage >= totalPages) idleMachinePage = totalPages - 1;
  if (idleMachinePage < 0) idleMachinePage = 0;

  if (!total) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="hist-table-empty">No idle data for selected filters</td></tr>`;
    if (pageInfo) pageInfo.textContent = "—";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const start = idleMachinePage * IDLE_MACHINE_PAGE_SIZE;
  const pageRows = idleMachineRows.slice(start, start + IDLE_MACHINE_PAGE_SIZE);

  body.innerHTML = pageRows
    .map((r) => {
      const cells = cols
        .map((c) => {
          if (c === "Machine No") {
            return `<td class="machine-no">${esc(r["Machine No"])}</td>`;
          }
          const v = r[c] ?? "—";
          const cls = v === "-" || v === "—" || v === "" ? "hist-empty" : "hist-val";
          const tdCls = c === "Total Idle" ? " col-total" : "";
          return `<td class="${tdCls.trim()}"><span class="${cls}">${esc(v)}</span></td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  if (pageInfo) {
    pageInfo.textContent = `${idleMachinePage + 1} / ${totalPages}`;
  }
  if (prevBtn) prevBtn.disabled = idleMachinePage <= 0;
  if (nextBtn) nextBtn.disabled = idleMachinePage >= totalPages - 1;
}

function renderIdleByMachine(idleRows, idleCols) {
  idleMachineRows = idleRows || [];
  idleMachineCols = idleMachineColumns(idleCols, idleMachineRows);
  idleMachinePage = 0;
  renderIdleByMachinePage();
}

function renderDashboard(data) {
  const s = data.summary || {};
  if (histEls.eff) histEls.eff.textContent = s.overall_efficiency != null ? `${s.overall_efficiency}%` : "—";
  if (histEls.loss) histEls.loss.textContent = s.overall_loss != null ? `${s.overall_loss}%` : "—";
  if (histEls.shots) histEls.shots.textContent = s.total_shots ?? "—";
  if (histEls.high) histEls.high.textContent = s.machines_above_80 ?? "—";
  if (histEls.low) histEls.low.textContent = s.machines_below_30 ?? "—";
  updateShiftDetail(data);
  const cc = histChartColors();

  const idleChart = data.chart_idle || {};
  renderHistChart("hist-idle-chart", "hist-idle-empty", "idle", {
    type: "doughnut",
    data: {
      labels: idleChart.labels || [],
      datasets: idleChart.datasets || [],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: {
            color: cc.legendAlt,
            font: { size: 11 },
            generateLabels: histLegendWithPct,
          },
        },
        tooltip: {
          displayColors: false,
          callbacks: {
            label(ctx) {
              const value = Number(ctx.raw || 0);
              const total = sumValues(ctx.dataset.data);
              return `${pctOf(value, total)}%`;
            },
          },
        },
        datalabels: {
          color: cc.datalabel,
          font: { weight: "600", size: 11 },
          formatter(value, ctx) {
            const total = sumValues(ctx.dataset.data);
            const pct = Number(pctOf(value, total));
            if (!pct || pct < 3) return "";
            return `${pct.toFixed(1)}%`;
          },
        },
      },
    },
  });

  const effChart = data.chart_efficiency || {};
  renderHistChart("hist-eff-chart", "hist-eff-empty", "eff", {
    type: "bar",
    data: effChart,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: cc.tick, maxRotation: 45 }, grid: { color: cc.grid } },
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { color: cc.tick, callback: (v) => `${v}%` },
          grid: { color: cc.grid },
          title: { display: true, text: "Efficiency %", color: cc.axisTitle },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            label(ctx) {
              return `${Number(ctx.parsed.y).toFixed(1)}%`;
            },
          },
        },
        datalabels: {
          anchor: "end",
          align: "top",
          offset: 2,
          color: cc.datalabel,
          font: { size: 10, weight: "600" },
          formatter: (v) => (v > 0 ? `${Number(v).toFixed(1)}%` : ""),
        },
      },
    },
  });

  renderIdleByMachine(data.idle_history || [], data.idle_columns || []);

  const shotChart = data.chart_shots || {};
  const shotLabels = shotChart.labels || [];
  const shotBars = (shotChart.datasets || []).filter((ds) => ds.label !== "Total");
  const { datasets: shotDatasets, yMax: shotYMax } = withTotalsLine(shotLabels, shotBars);
  renderHistChart("hist-shot-chart", "hist-shot-empty", "shots", {
    type: "bar",
    data: { labels: shotLabels, datasets: shotDatasets },
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
      scales: {
        x: {
          stacked: true,
          ticks: { color: cc.tick, maxRotation: 25, minRotation: 0, autoSkip: true },
          grid: { color: cc.grid },
          title: { display: true, text: "Time Bucket", color: cc.axisTitle },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: shotYMax,
          ticks: { color: cc.tick },
          grid: { color: cc.grid },
          title: { display: true, text: "Shots", color: cc.axisTitle },
        },
        yLine: {
          stacked: false,
          beginAtZero: true,
          max: shotYMax,
          display: false,
          grid: { drawOnChartArea: false },
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: { color: cc.legendAlt, font: { size: 10, family: "Montserrat" } },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          backgroundColor: cc.tooltipBg,
          titleColor: cc.tooltipTitle,
          bodyColor: cc.tooltipBody,
          borderColor: cc.tooltipBorder,
          borderWidth: 1,
        },
      },
    },
  });

  const sel = {
    department: histEls.department?.value || "",
    supervisor: histEls.supervisor?.value || "",
    machine: histEls.machine?.value || "",
  };
  setHistFilterMeta(data.filters);
  if (sel.department && (histFilterMeta?.departments || []).includes(sel.department)) {
    histEls.department.value = sel.department;
  }
  fillHistSelect(histEls.supervisor, cascadeHistSupervisors());
  if (sel.supervisor && cascadeHistSupervisors().includes(sel.supervisor)) {
    histEls.supervisor.value = sel.supervisor;
  }
  fillHistSelect(histEls.machine, cascadeHistMachines());
  if (sel.machine && cascadeHistMachines().includes(sel.machine)) {
    histEls.machine.value = sel.machine;
  }
}

async function fetchDayArchives(force = false) {
  const unit = histEls.unit?.value || "unit_i";
  const date = histEls.date?.value;
  if (!date) {
    setHistMessage("Select a date first");
    return false;
  }
  const key = dayCacheKey();
  if (!force && histDayCache && histDayCache.key === key) {
    return true;
  }
  histLoading = true;
  if (histEls.clear) histEls.clear.disabled = true;
  if (histEls.exportBtn) histEls.exportBtn.disabled = true;
  showHistLoading(true, "Fetching details");
  setHistMessage("Fetching details from storage…");
  try {
    const res = await fetch(`/api/history/day?unit=${encodeURIComponent(unit)}&date=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Failed to load day archives");
    histDayCache = { key, unit, date, shifts: data.shifts || {} };
    return true;
  } catch (e) {
    histDayCache = null;
    setHistMessage("Error: " + e.message);
    return false;
  } finally {
    histLoading = false;
    if (histEls.clear) histEls.clear.disabled = false;
    if (histEls.exportBtn) histEls.exportBtn.disabled = !histLastLoaded?.machines?.length;
    showHistLoading(false);
  }
}

async function applyLocalFilters() {
  if (histProcessing || histLoading) return;
  const date = histEls.date?.value;
  const shiftKey = histEls.shift?.value || "I";
  if (!date) {
    setHistMessage("Select a date first");
    return;
  }

  const key = dayCacheKey();
  const needsFetch = !histDayCache || histDayCache.key !== key;
  if (needsFetch) {
    if (!(await fetchDayArchives(true))) return;
  }

  if (!histDayCache?.shifts?.[shiftKey]) {
    setHistMessage(`No archived data for ${date} Shift ${shiftKey}`);
    return;
  }

  const cached = histDayCache.shifts[shiftKey];
  histProcessing = true;
  if (histEls.filter) histEls.filter.disabled = true;
  if (histEls.clear) histEls.clear.disabled = true;
  if (histEls.exportBtn) histEls.exportBtn.disabled = true;
  showHistLoading(true, "Please wait");
  setHistMessage("Please wait…");

  try {
    const res = await fetch("/api/history/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: histEls.unit?.value || "unit_i",
        shift_id: cached.shift_id,
        csv_b64: cached.csv_b64,
        archive: cached.archive,
        department: histEls.department?.value || "",
        supervisor: histEls.supervisor?.value || "",
        machine: histEls.machine?.value || "",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Filter failed");
    renderDashboard(data);
  } catch (e) {
    setHistMessage("Error: " + e.message);
  } finally {
    histProcessing = false;
    if (histEls.filter) histEls.filter.disabled = false;
    if (histEls.clear) histEls.clear.disabled = false;
    if (histEls.exportBtn) histEls.exportBtn.disabled = !histLastLoaded?.machines?.length;
    showHistLoading(false);
  }
}

async function initHistoryDashboard() {
  applyDefaultPreviousShift();
  await loadShiftList();
  await loadHistFilterMeta();
  await applyLocalFilters();
}

function switchMainTab(tab) {
  document.querySelectorAll(".nav-modes .tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.getElementById("tab-live")?.classList.toggle("active", tab === "live");
  document.getElementById("tab-history")?.classList.toggle("active", tab === "history");
  if (tab === "history") {
    initHistoryDashboard();
    requestAnimationFrame(() => {
      if (typeof window.resizeHistoryCharts === "function") window.resizeHistoryCharts();
    });
  }
  if (tab === "live" && typeof window.refreshLiveSnapshot === "function") {
    window.refreshLiveSnapshot();
    requestAnimationFrame(() => {
      if (typeof window.resizeLiveChart === "function") window.resizeLiveChart();
    });
  }
}

document.querySelectorAll(".nav-modes .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchMainTab(btn.dataset.tab));
});

window.onHistoryUnitChange = function () {
  invalidateDayCache();
  initHistoryDashboard();
};

histEls.filter?.addEventListener("click", () => applyLocalFilters());
histEls.clear?.addEventListener("click", () => clearHistFilters());
histEls.exportBtn?.addEventListener("click", () => exportHistCsv());

histEls.date?.addEventListener("change", async () => {
  invalidateDayCache();
  await loadHistFilterMeta();
  updateShiftDetail(null);
});

histEls.shift?.addEventListener("change", async () => {
  await loadHistFilterMeta();
  updateShiftDetail(null);
});

histEls.department?.addEventListener("change", () => {
  fillHistSelect(histEls.supervisor, cascadeHistSupervisors());
  fillHistSelect(histEls.machine, cascadeHistMachines());
});

histEls.supervisor?.addEventListener("change", () => {
  fillHistSelect(histEls.machine, cascadeHistMachines());
});

document.getElementById("hist-idle-prev")?.addEventListener("click", () => {
  if (idleMachinePage > 0) {
    idleMachinePage -= 1;
    renderIdleByMachinePage();
  }
});
document.getElementById("hist-idle-next")?.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(idleMachineRows.length / IDLE_MACHINE_PAGE_SIZE));
  if (idleMachinePage < totalPages - 1) {
    idleMachinePage += 1;
    renderIdleByMachinePage();
  }
});

if (document.getElementById("tab-history")?.classList.contains("active")) {
  initHistoryDashboard();
}

window.resizeHistoryCharts = function () {
  Object.values(histCharts).forEach((chart) => {
    if (chart) chart.resize();
  });
};
