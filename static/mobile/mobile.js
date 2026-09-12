const POLL_MS = 8000;
const ACK_KEY = "alubee_mobile_ack_v1";
const SEEN_KEY = "alubee_mobile_alarmed_v1";

// Alarms ONLY on /mobile (or /m) — never on the main Live dashboard
const path = String(location.pathname || "").replace(/\/+$/, "") || "/";
const IS_MOBILE_ROUTE = path === "/mobile" || path === "/m";
if (!IS_MOBILE_ROUTE) {
  console.info("Alubee mobile alarm skipped — not on /mobile route");
}

const liveRoot = document.getElementById("live-root");
const alarmsRoot = document.getElementById("alarms-root");
const historyRoot = document.getElementById("history-root");
const polledAt = document.getElementById("polled-at");
const alarmBadge = document.getElementById("alarm-badge");
const toast = document.getElementById("toast");
const ackAllBtn = document.getElementById("ack-all-btn");
const histUnit = document.getElementById("hist-unit");
const histRefresh = document.getElementById("hist-refresh");

let latest = null;
let toastTimer = null;

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

let acked = loadSet(ACK_KEY);
let alreadyAlarmed = loadSet(SEEN_KEY);

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(online, label) {
  const cls = online ? "badge-ok" : "badge-bad";
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function formatAge(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function showToast(msg) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000);
  try {
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  } catch (_) {}
  // Short beep via Web Audio (one-shot)
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, 220);
  } catch (_) {}
}

function activeAlarms(data) {
  return (data.alarms || []).filter((a) => !acked.has(a.key));
}

function pruneAck(data) {
  const liveKeys = new Set((data.alarms || []).map((a) => a.key));
  // Clear ack/alarmed when entity is healthy again
  for (const key of [...acked]) {
    if (!liveKeys.has(key)) acked.delete(key);
  }
  for (const key of [...alreadyAlarmed]) {
    if (!liveKeys.has(key)) alreadyAlarmed.delete(key);
  }
  saveSet(ACK_KEY, acked);
  saveSet(SEEN_KEY, alreadyAlarmed);
}

function maybeFireAlarms(data) {
  if (!IS_MOBILE_ROUTE) return;
  pruneAck(data);
  const fresh = [];
  for (const a of data.alarms || []) {
    if (acked.has(a.key)) continue;
    if (alreadyAlarmed.has(a.key)) continue;
    alreadyAlarmed.add(a.key);
    fresh.push(a);
  }
  saveSet(SEEN_KEY, alreadyAlarmed);
  if (fresh.length) {
    const names = fresh.map((a) => a.name).join(", ");
    showToast(`Offline: ${names}`);
  }
}

function renderLive(data) {
  if (!liveRoot) return;
  const units = data.units || [];
  if (!units.length) {
    liveRoot.innerHTML = `<div class="empty">No status yet. Is cloud_agent running?</div>`;
    return;
  }
  liveRoot.innerHTML = units
    .map((u) => {
      const srv = u.server || {};
      const machines = u.machines || [];
      const rows = machines
        .map(
          (m) => `<div class="row">
            <div>
              <div class="row-name">${esc(m.name)}</div>
              <div class="row-sub">${esc(m.department || m.unit_label || "")}</div>
            </div>
            ${badge(m.online, m.status)}
          </div>`
        )
        .join("");
      return `<article class="card">
        <div class="unit-head">
          <div class="unit-title">${esc(u.unit_label)}</div>
          <div class="unit-meta">${esc(u.counts.online)}/${esc(u.counts.machines)} online</div>
        </div>
        <div class="row">
          <div>
            <div class="row-name">${esc(srv.name || "Server")}</div>
            <div class="row-sub">${esc(srv.pc_name || "")} · ${esc(formatAge(srv.age_sec))}</div>
          </div>
          ${badge(srv.online, srv.status)}
        </div>
        ${rows || `<div class="empty">No machines in snapshot</div>`}
      </article>`;
    })
    .join("");
}

function renderAlarms(data) {
  if (!alarmsRoot) return;
  const list = activeAlarms(data);
  const n = list.length;
  if (alarmBadge) {
    alarmBadge.textContent = String(n);
    alarmBadge.classList.toggle("hidden", n === 0);
  }
  if (ackAllBtn) ackAllBtn.disabled = n === 0;

  if (!list.length) {
    alarmsRoot.innerHTML = `<div class="empty">No active alarms</div>`;
    return;
  }
  alarmsRoot.innerHTML = list
    .map(
      (a) => `<article class="card" data-key="${esc(a.key)}">
        <div class="row" style="border:0;padding:0">
          <div>
            <div class="row-name">${esc(a.name)}</div>
            <div class="row-sub">${esc(a.unit_label)} · ${esc(a.kind)} · ${esc(a.status)}</div>
          </div>
          ${badge(false, a.status)}
        </div>
        <div class="alarm-actions">
          <button type="button" class="btn ghost ack-one" data-key="${esc(a.key)}">Acknowledge</button>
        </div>
      </article>`
    )
    .join("");

  alarmsRoot.querySelectorAll(".ack-one").forEach((btn) => {
    btn.addEventListener("click", () => {
      acked.add(btn.dataset.key);
      saveSet(ACK_KEY, acked);
      renderAlarms(latest || data);
    });
  });
}

function renderHistory(events) {
  if (!historyRoot) return;
  if (!events || !events.length) {
    historyRoot.innerHTML = `<div class="empty">No connectivity events yet</div>`;
    return;
  }
  historyRoot.innerHTML = events
    .map((e) => {
      const on = String(e.event || "") === "online";
      const label = e.kind === "server" ? (e.unit_id === "unit_ii" ? "Unit II Server" : "Unit I Server") : e.name;
      return `<article class="card event">
        <div class="dot ${on ? "on" : ""}"></div>
        <div>
          <div class="event-title">${esc(label)} · ${esc(e.event || "")}</div>
          <div class="event-meta">${esc(e.unit_id)} · ${esc(e.at || "")}</div>
        </div>
      </article>`;
    })
    .join("");
}

async function refreshStatus() {
  try {
    const res = await fetch("/api/mobile/status", { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "status failed");
    latest = data;
    if (polledAt) polledAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    maybeFireAlarms(data);
    renderLive(data);
    renderAlarms(data);
  } catch (err) {
    if (polledAt) polledAt.textContent = "Status unreachable";
    console.error(err);
  }
}

async function refreshHistory() {
  const unit = histUnit ? histUnit.value : "";
  const q = new URLSearchParams({ limit: "120" });
  if (unit) q.set("unit", unit);
  try {
    const res = await fetch(`/api/mobile/history?${q}`, { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "history failed");
    renderHistory(data.events || []);
  } catch (err) {
    historyRoot.innerHTML = `<div class="empty">Could not load history</div>`;
    console.error(err);
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = document.getElementById(`panel-${tab.dataset.panel}`);
    if (panel) panel.classList.add("active");
    if (tab.dataset.panel === "history") refreshHistory();
  });
});

if (ackAllBtn) {
  ackAllBtn.addEventListener("click", () => {
    for (const a of (latest && latest.alarms) || []) acked.add(a.key);
    saveSet(ACK_KEY, acked);
    renderAlarms(latest || { alarms: [] });
  });
}

if (histRefresh) histRefresh.addEventListener("click", refreshHistory);
if (histUnit) histUnit.addEventListener("change", refreshHistory);

refreshStatus();
setInterval(refreshStatus, POLL_MS);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/mobile/sw.js").catch(() => {});
}
