/** Cloud History dashboard — archived shift CSV analytics */
let histShifts = [];
let histCharts = { idle: null, eff: null, shots: null };
let histLoading = false;

const histEls = {
  unit: document.getElementById("hist-unit"),
  date: document.getElementById("hist-date"),
  shift: document.getElementById("hist-shift"),
  department: document.getElementById("hist-department"),
  supervisor: document.getElementById("hist-supervisor"),
  machine: document.getElementById("hist-machine"),
  idleType: document.getElementById("hist-idle-type"),
  apply: document.getElementById("hist-apply"),
  hint: document.getElementById("hist-hint"),
  shiftLine: document.getElementById("hist-shift-line"),
  metaLine: document.getElementById("hist-meta-line"),
  eff: document.getElementById("hist-eff"),
  loss: document.getElementById("hist-loss"),
  shots: document.getElementById("hist-shots"),
  maint: document.getElementById("hist-maint"),
  machinesBody: document.getElementById("hist-machines-body"),
  idleHead: document.getElementById("hist-idle-head"),
  idleBody: document.getElementById("hist-idle-body"),
  maintBody: document.getElementById("hist-maint-body"),
};

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function effClass(dir) {
  if (dir === "high") return "eff-high";
  if (dir === "mid") return "eff-mid";
  if (dir === "low") return "eff-low";
  return "eff-flat";
}

function currentShiftId() {
  const d = histEls.date?.value;
  const s = histEls.shift?.value || "I";
  if (!d) return "";
  return `${d}-${s}`;
}

function fillSelect(el, values, allLabel = "All") {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>`;
  (values || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  });
  if (cur && [...el.options].some((o) => o.value === cur)) el.value = cur;
}

async function loadShiftList() {
  const unit = histEls.unit?.value || "unit_i";
  if (histEls.hint) histEls.hint.textContent = "Loading archived shifts…";
  try {
    const res = await fetch(`/api/history/shifts?unit=${encodeURIComponent(unit)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load shifts");
    histShifts = data.shifts || [];
    const dates = [...new Set(histShifts.map((s) => s.shift_date).filter(Boolean))].sort().reverse();
    if (histEls.date) {
      histEls.date.innerHTML = "";
      dates.forEach((d) => {
        const o = document.createElement("option");
        o.value = d;
        o.textContent = d;
        histEls.date.appendChild(o);
      });
      if (dates.length) histEls.date.value = dates[0];
    }
    if (histEls.hint) {
      histEls.hint.textContent = dates.length
        ? `${histShifts.length} archived shift(s) · click Load`
        : "No archived shifts for this unit yet";
    }
  } catch (e) {
    if (histEls.hint) histEls.hint.textContent = "Error: " + e.message;
  }
}

function updateFilterOptions(filters) {
  if (!filters) return;
  fillSelect(histEls.department, filters.departments);
  fillSelect(histEls.supervisor, filters.supervisors);
  fillSelect(histEls.machine, filters.machines);
  fillSelect(histEls.idleType, filters.idle_types);
}

function destroyChart(key) {
  if (histCharts[key]) {
    histCharts[key].destroy();
    histCharts[key] = null;
  }
}

function renderChart(canvasId, emptyId, key, config) {
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
  histCharts[key] = new Chart(canvas, config);
}

function renderDashboard(data) {
  const s = data.summary || {};
  if (histEls.eff) histEls.eff.textContent = s.overall_efficiency != null ? `${s.overall_efficiency}%` : "—";
  if (histEls.loss) histEls.loss.textContent = s.overall_loss != null ? `${s.overall_loss}%` : "—";
  if (histEls.shots) histEls.shots.textContent = s.total_shots ?? "—";
  if (histEls.maint) histEls.maint.textContent = s.maintenance_time || "—";
  if (histEls.shiftLine) histEls.shiftLine.textContent = `${data.shift_name || ""} · ${data.shift_range || ""}`;
  if (histEls.metaLine) {
    const arch = data.archive || {};
    histEls.metaLine.textContent = `Archived ${arch.archived_at || "—"} · ${arch.row_count || 0} events · ${data.unit_id || ""}`;
  }

  const machines = data.machines || [];
  if (histEls.machinesBody) {
    if (!machines.length) {
      histEls.machinesBody.innerHTML = '<tr><td colspan="8" class="empty">No machines match filters</td></tr>';
    } else {
      histEls.machinesBody.innerHTML = machines
        .map(
          (m) => `<tr>
          <td class="machine-no">${esc(m["Machine No"])}</td>
          <td>${esc(m.Department)}</td>
          <td>${esc(m.Supervisor)}</td>
          <td>${esc(m.Shots)}</td>
          <td>${esc(m["Avg Cycle Time"])}</td>
          <td class="${effClass(m.EfficiencyDir)}">${esc(m.Efficiency)}</td>
          <td>${esc(m["Total Idle"])}</td>
          <td>${esc(m["Efficiency Loss"])}</td>
        </tr>`
        )
        .join("");
    }
  }

  const idleCols = data.idle_columns || [];
  const idleRows = data.idle_history || [];
  if (histEls.idleHead) {
    histEls.idleHead.innerHTML = ["Machine No", "Department", "Supervisor", ...idleCols]
      .map((c) => `<th>${esc(c)}</th>`)
      .join("");
  }
  if (histEls.idleBody) {
    if (!idleRows.length) {
      histEls.idleBody.innerHTML = '<tr><td colspan="20" class="empty">No idle history</td></tr>';
    } else {
      histEls.idleBody.innerHTML = idleRows
        .map((r) => {
          const cells = ["Machine No", "Department", "Supervisor", ...idleCols]
            .map((c) => {
              const v = r[c] ?? "—";
              const cls = c === "Efficiency Loss" && String(v).replace("%", "") >= 20 ? "idle-loss-bad" : "";
              return `<td class="${cls}">${esc(v)}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
    }
  }

  const maint = data.maintenance || [];
  if (histEls.maintBody) {
    if (!maint.length) {
      histEls.maintBody.innerHTML = '<tr><td colspan="4" class="empty">No maintenance events</td></tr>';
    } else {
      histEls.maintBody.innerHTML = maint
        .map(
          (m) => `<tr>
          <td class="machine-no">${esc(m.machine_no)}</td>
          <td>${esc(m.from)}</td>
          <td>${esc(m.to)}</td>
          <td>${esc(m.duration)}</td>
        </tr>`
        )
        .join("");
    }
  }

  const idleChart = data.chart_idle || {};
  renderChart("hist-idle-chart", "hist-idle-empty", "idle", {
    type: "doughnut",
    data: {
      labels: idleChart.labels || [],
      datasets: idleChart.datasets || [],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { color: "#e8f4ff", font: { size: 11 } } } },
    },
  });

  const effChart = data.chart_efficiency || {};
  renderChart("hist-eff-chart", "hist-eff-empty", "eff", {
    type: "bar",
    data: effChart,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: "#9dbbd4", maxRotation: 45 }, grid: { color: "rgba(148,183,214,0.15)" } },
        y: { beginAtZero: true, max: 100, ticks: { color: "#9dbbd4" }, grid: { color: "rgba(148,183,214,0.15)" } },
      },
      plugins: { legend: { display: false } },
    },
  });

  const shotChart = data.chart_shots || {};
  renderChart("hist-shot-chart", "hist-shot-empty", "shots", {
    type: "bar",
    data: shotChart,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { color: "#9dbbd4" }, grid: { color: "rgba(148,183,214,0.15)" } },
        y: { stacked: true, beginAtZero: true, ticks: { color: "#9dbbd4" }, grid: { color: "rgba(148,183,214,0.15)" } },
      },
      plugins: { legend: { labels: { color: "#e8f4ff", font: { size: 10 } } } },
    },
  });

  updateFilterOptions(data.filters);
}

async function loadDashboard() {
  if (histLoading) return;
  const shiftId = currentShiftId();
  if (!shiftId) {
    if (histEls.hint) histEls.hint.textContent = "Select a date first";
    return;
  }
  const params = new URLSearchParams({
    unit: histEls.unit?.value || "unit_i",
    shift_id: shiftId,
    department: histEls.department?.value || "",
    supervisor: histEls.supervisor?.value || "",
    machine: histEls.machine?.value || "",
    idle_type: histEls.idleType?.value || "",
  });
  histLoading = true;
  if (histEls.hint) histEls.hint.textContent = "Loading shift data…";
  try {
    const res = await fetch(`/api/history/dashboard?${params}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Load failed");
    renderDashboard(data);
    if (histEls.hint) histEls.hint.textContent = `${data.summary?.machines || 0} machines · filtered view`;
  } catch (e) {
    if (histEls.hint) histEls.hint.textContent = "Error: " + e.message;
  } finally {
    histLoading = false;
  }
}

function switchMainTab(tab) {
  document.querySelectorAll(".main-tabs .tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.getElementById("tab-live")?.classList.toggle("active", tab === "live");
  document.getElementById("tab-history")?.classList.toggle("active", tab === "history");
  if (tab === "history") loadShiftList();
}

document.querySelectorAll(".main-tabs .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchMainTab(btn.dataset.tab));
});

histEls.unit?.addEventListener("change", loadShiftList);
histEls.apply?.addEventListener("click", loadDashboard);
histEls.date?.addEventListener("change", () => {
  const sid = currentShiftId();
  const match = histShifts.find((s) => s.shift_id === sid);
  if (match?.shift_name) histEls.shift.value = match.shift_name;
});

// Initial history date list when page loads (if user opens History first)
if (document.getElementById("tab-history")?.classList.contains("active")) {
  loadShiftList();
}
