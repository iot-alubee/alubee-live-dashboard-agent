const REFRESH_MS = 2000;

const clockEl = document.getElementById("clock");
const shiftEl = document.getElementById("shift-line");
const machinesBody = document.getElementById("machines-body");
const idleHead = document.getElementById("idle-head");
const idleBody = document.getElementById("idle-body");
const filterDepartment = document.getElementById("filter-department");
const filterSupervisor = document.getElementById("filter-supervisor");
const filterStatus = document.getElementById("filter-status");
const filterHint = document.getElementById("filter-hint");

let currentUnit = "unit_i";
let latestData = null;
let refreshInFlight = false;
let idleColsKey = "";

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
      '<tr><td colspan="14" class="empty">No machines in this snapshot / filter.</td></tr>';
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
        <td class="${r["Reset Status"] === "Not cleared" ? "reset-bad" : ""}">${esc(r["Reset Status"] || "—")}</td>
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
    idleBody.innerHTML = `<tr><td colspan="${n || 1}" class="empty">No idle history in snapshot yet.</td></tr>`;
    return;
  }
  idleBody.innerHTML = rows
    .map((r) => {
      const levels = r._levels || {};
      const cells = (cols || [])
        .map((c) => {
          const lvl = levels[c] || "empty";
          return `<td class="idle-cell idle-${esc(lvl)}">${esc(r[c] || "—")}</td>`;
        })
        .join("");
      return `<tr><td class="machine-no">${esc(r["Machine No"])}</td>${cells}</tr>`;
    })
    .join("");
}

function applyAndRender() {
  if (!latestData) return;
  const all = latestData.machines || [];
  setupFilters(all);
  const machines = all.filter(rowMatches);
  const set = new Set(machines.map((m) => m["Machine No"]));

  document.getElementById("cnt-total").textContent = machines.length;
  document.getElementById("cnt-run").textContent = machines.filter((r) => r.Status === "Running").length;
  document.getElementById("cnt-idle").textContent = machines.filter((r) => r.Status === "Idle").length;
  document.getElementById("cnt-disc").textContent = machines.filter(
    (r) => r.Status === "Disconnected"
  ).length;

  renderMachines(machines);

  const idleRows = (latestData.idle_history || []).filter((r) =>
    set.size ? set.has(r["Machine No"]) : true
  );
  renderIdle(idleRows, latestData.idle_columns || []);
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const res = await fetch("/live?unit=" + encodeURIComponent(currentUnit), { cache: "no-store" });
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();
    latestData = data;
    clockEl.textContent = data.updated_at
      ? new Date(data.updated_at).toLocaleString()
      : data.polled_at || "--";
    shiftEl.textContent = `${data.shift_name || "—"} · ${data.shift_range || ""}`.trim();
    if (filterHint) {
      filterHint.textContent = data.message
        ? data.message
        : `Cloud snapshot · plant upload ~10s · UI poll 2s · ${data.pc_name || ""}`;
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
    refresh();
  });
});

[filterDepartment, filterSupervisor, filterStatus].forEach((el) => {
  if (el) el.addEventListener("change", () => {
    filterState.department = filterDepartment.value;
    filterState.supervisor = filterSupervisor.value;
    filterState.status = filterStatus.value;
    applyAndRender();
  });
});

refresh();
setInterval(refresh, REFRESH_MS);
