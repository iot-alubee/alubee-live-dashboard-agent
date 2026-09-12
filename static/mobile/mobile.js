import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";

const POLL_MS = 8000;
const ACK_KEY = "alubee_mobile_ack_v1";
const SEEN_KEY = "alubee_mobile_alarmed_v1";
const TOKEN_KEY = "alubee_fcm_token_v1";
const ALARM_MS = 10000;
const RINGTONE_URL = "/static/mobile/alarm_ringtone.wav";

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
const pushStatus = document.getElementById("push-status");
const pushEnableBtn = document.getElementById("push-enable-btn");

let latest = null;
let toastTimer = null;
let fcmMessaging = null;
let alarmAudio = null;
let alarmStopTimer = null;

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

function setPushUi(text, enabled) {
  if (pushStatus) pushStatus.textContent = text;
  if (pushEnableBtn) {
    pushEnableBtn.disabled = !!enabled;
    pushEnableBtn.textContent = enabled ? "On" : "Enable";
  }
}

function stopAlarmSound() {
  clearTimeout(alarmStopTimer);
  alarmStopTimer = null;
  try {
    if (navigator.vibrate) navigator.vibrate(0);
  } catch (_) {}
  if (alarmAudio) {
    try {
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    } catch (_) {}
  }
}

function playRingtoneAlarm() {
  stopAlarmSound();
  try {
    if (!alarmAudio) {
      alarmAudio = new Audio(RINGTONE_URL);
      alarmAudio.preload = "auto";
    }
    alarmAudio.loop = true;
    alarmAudio.volume = 1.0;
    alarmAudio.currentTime = 0;
    const p = alarmAudio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => console.warn("Ringtone blocked:", err));
    }
  } catch (err) {
    console.warn("Ringtone failed:", err);
  }
  try {
    if (navigator.vibrate) {
      // Strong pulse while ringtone plays (app open only)
      const pattern = [];
      for (let i = 0; i < 25; i++) pattern.push(450, 150);
      navigator.vibrate(pattern);
    }
  } catch (_) {}
  alarmStopTimer = setTimeout(() => stopAlarmSound(), ALARM_MS);
}

/** Play ringtone when user opens the app (notification tap / unlock → open). */
function playAlarmOnOpen(title, body) {
  const t = title || "Alubee Status";
  const b = body || "Offline alert";
  showToast(`${t}: ${b}`, { ring: true });
}

function showToast(msg, { ring = true } = {}) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), ALARM_MS + 1500);
  if (ring) playRingtoneAlarm();
}

function activeAlarms(data) {
  return (data.alarms || []).filter((a) => !acked.has(a.key));
}

function pruneAck(data) {
  const liveKeys = new Set((data.alarms || []).map((a) => a.key));
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
    showToast(`Offline: ${names}`, { ring: true });
  }
  if (!activeAlarms(data).length) stopAlarmSound();
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
      stopAlarmSound();
      if (toast) toast.classList.add("hidden");
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
      const label =
        e.kind === "server"
          ? e.unit_id === "unit_ii"
            ? "Unit II Server"
            : "Unit I Server"
          : e.name;
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

async function enablePush() {
  if (!IS_MOBILE_ROUTE) return;
  try {
    setPushUi("Requesting permission…", false);
    const cfgRes = await fetch("/api/mobile/push/config", { cache: "no-store" });
    const cfg = await cfgRes.json();
    if (!cfg.ok || !cfg.configured) {
      setPushUi("Push not configured on server (set FIREBASE_* env vars).", false);
      return;
    }
    const supported = await isSupported();
    if (!supported) {
      setPushUi("This browser does not support web push.", false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setPushUi("Notifications blocked — allow them in browser settings.", false);
      return;
    }

    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;

    const app = initializeApp(cfg.firebase);
    fcmMessaging = getMessaging(app);
    const token = await getToken(fcmMessaging, {
      vapidKey: cfg.vapidKey,
      serviceWorkerRegistration: reg,
    });
    if (!token) {
      setPushUi("Could not get FCM token.", false);
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    await fetch("/api/mobile/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        platform: navigator.platform || "",
      }),
    });

    onMessage(fcmMessaging, (payload) => {
      const title = payload.notification?.title || payload.data?.title || "Alubee Status";
      const body = payload.notification?.body || payload.data?.body || "Offline alert";
      showToast(`${title}: ${body}`, { ring: true });
    });

    setPushUi("Push on — locked: sound + vibe; open app for ringtone.", true);
  } catch (err) {
    console.error(err);
    setPushUi(`Enable failed: ${err.message || err}`, false);
  }
}

async function initPushBar() {
  if (!IS_MOBILE_ROUTE) return;
  try {
    const cfgRes = await fetch("/api/mobile/push/config", { cache: "no-store" });
    const cfg = await cfgRes.json();
    if (!cfg.configured) {
      setPushUi("Server push not configured yet (Firebase env).", false);
      if (pushEnableBtn) pushEnableBtn.disabled = true;
      return;
    }
    if (Notification.permission === "granted" && localStorage.getItem(TOKEN_KEY)) {
      setPushUi("Push on — tap Enable again to refresh token.", false);
    } else {
      setPushUi("Enable notifications to alert even when the app is closed.", false);
    }
  } catch {
    setPushUi("Could not load push config.", false);
  }
  if (pushEnableBtn) pushEnableBtn.addEventListener("click", enablePush);
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
    stopAlarmSound();
    if (toast) toast.classList.add("hidden");
    renderAlarms(latest || { alarms: [] });
  });
}

if (histRefresh) histRefresh.addEventListener("click", refreshHistory);
if (histUnit) histUnit.addEventListener("change", refreshHistory);

if (IS_MOBILE_ROUTE) {
  refreshStatus();
  setInterval(refreshStatus, POLL_MS);
  initPushBar();

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "PLAY_ALARM") {
        playAlarmOnOpen(msg.title, msg.body);
      }
    });
  }
  const params = new URLSearchParams(location.search || "");
  if (params.get("alarm") === "1") {
    playAlarmOnOpen("Offline alarm", "Open from notification");
    try {
      history.replaceState({}, "", "/mobile");
    } catch (_) {}
  }

  // Returning to the app with unacked alarms → play ringtone
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !latest) return;
    const act = activeAlarms(latest);
    if (act.length) {
      playAlarmOnOpen("Offline", act.map((a) => a.name).join(", "));
    }
  });
}
