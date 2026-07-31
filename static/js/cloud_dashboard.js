/** Cloud Live Monitor — same layout as local; clock live, data every 10s. */
const SNAPSHOT_MS = 10000;
const CLOCK_MS = 1000;

const clockEl = document.getElementById("clock");
const shiftEl = document.getElementById("shift-line");
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
  department: "All",
  supervisor: "All",
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

function tickClock() {
  if (clockEl) clockEl.textContent = formatNow();
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
  if (dir === "up") return "eff-up";
  if (dir === "down") return "eff-down";
  if (dir === "same") return "eff-same";
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
  if (!vals.includes(prev)) prev = includeAll ? "All" : vals[0] || "All";
  sel.innerHTML = vals
    .map((v) => `<option value="${esc(v)}"${v === prev ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
  sel.value = prev;
  return prev;
}

function setupFilters(machines) {
  const depts = uniqueSorted(machines.map((m) => m.Department));
  const sups = uniqueSorted(machines.map((m) => m.Supervisor));
  const statuses = ["Running", "Idle", "Disconnected", "Reset"];
  filterState.department = fillSelect(filterDepartment, depts, filterState.department, true);
  filterState.supervisor = fillSelect(filterSupervisor, sups, filterState.supervisor, true);
  filterState.status = fillSelect(filterStatus, statuses, filterState.status, true);
}

function rowMatches(r) {
  if (filterState.department !== "All" && r.Department !== filterState.department) return false;
  if (filterState.supervisor !== "All" && r.Supervisor !== filterState.supervisor) return false;
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
        <td>${esc(r.Elapsed)}</td>
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
          const cls =
            lvl === "crit"
              ? "idle-crit"
              : lvl === "warn"
              ? "idle-warn"
              : lvl === "ok"
              ? "idle-ok"
              : "idle-empty";
          return `<td><span class="${cls}">${esc(r[c])}</span></td>`;
        })
        .join("");
      return `<tr><td class="machine-no">${esc(r["Machine No"])}</td>${cells}</tr>`;
    })
    .join("");
}

function renderChart(chart) {
  const labels = (chart && chart.labels) || [];
  const datasets = (chart && chart.datasets) || [];
  if (!labels.length || !datasets.length) {
    if (chartEmpty) chartEmpty.classList.remove("hidden");
    if (shotChart) {
      shotChart.destroy();
      shotChart = null;
    }
    return;
  }
  if (chartEmpty) chartEmpty.classList.add("hidden");
  const ctx = document.getElementById("shot-chart").getContext("2d");
  if (shotChart) {
    shotChart.data.labels = labels;
    shotChart.data.datasets = datasets;
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
          ticks: { color: "#d6e4f0" },
          grid: { color: "rgba(157,187,212,0.12)" },
          title: { display: true, text: "Shots", color: "#9dbbd4" },
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
      if (filterState.department !== "All" && r.Department !== filterState.department)
        return false;
      if (filterState.supervisor !== "All" && r.Supervisor !== filterState.supervisor)
        return false;
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
  const filteredDatasets = (chart.datasets || []).filter((ds) => set.has(ds.label));
  renderChart({ labels: chart.labels || [], datasets: filteredDatasets });
}

async function refreshSnapshot() {
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
        : `Near real-time · data every 10s · ${data.pc_name || ""}`.trim();
    }
    applyAndRender();
  } catch (err) {
    console.error(err);
    if (filterHint) filterHint.textContent = "Error: " + err.message;
  } finally {
    refreshInFlight = false;
  }
}

document.querySelectorAll(".tab-btn[data-unit]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn[data-unit]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentUnit = btn.dataset.unit;
    filterState.department = "All";
    filterState.supervisor = "All";
    filterState.status = "All";
    refreshSnapshot();
  });
});

[filterDepartment, filterSupervisor, filterStatus].forEach((el) => {
  if (el)
    el.addEventListener("change", () => {
      filterState.department = filterDepartment.value;
      filterState.supervisor = filterSupervisor.value;
      filterState.status = filterStatus.value;
      applyAndRender();
    });
});

tickClock();
setInterval(tickClock, CLOCK_MS);
refreshSnapshot();
setInterval(refreshSnapshot, SNAPSHOT_MS);
