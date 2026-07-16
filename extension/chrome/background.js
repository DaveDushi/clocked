/**
 * clocked bridge — report active tab host to the desktop app.
 *
 * Does NOT track or sync time itself. It only tells the desktop tray app
 * "the active tab is github.com right now" so when Chrome is focused, time
 * is attributed to that site. Hours still come from the desktop clock.
 *
 * Sends domain + short title only — never full URL path/query.
 *
 * Token is stored in chrome.storage.local (this machine only) — never
 * storage.sync, so the clk_ secret is not uploaded to Google account sync.
 */

const DEFAULT_PORT = 19532;
const ALARM = "clocked-tab-ping";

/** Ensure the keepalive alarm exists (MV3 service workers sleep; alarms wake them). */
function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

// One-time migrate token/settings out of storage.sync (older builds).
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const local = await chrome.storage.local.get(["token", "port", "enabled"]);
    if (local.token) return;
    const sync = await chrome.storage.sync.get(["token", "port", "enabled"]);
    if (!sync.token) return;
    await chrome.storage.local.set({
      token: sync.token,
      port: sync.port ?? DEFAULT_PORT,
      enabled: sync.enabled !== false,
    });
    await chrome.storage.sync.remove(["token", "port", "enabled"]);
  } catch {
    /* ignore migration errors */
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) reportActiveTab();
});

// Immediate updates when the user switches tabs or navigates — this is the
// main accuracy path; the alarm is just a heartbeat for long stays on one tab.
chrome.tabs.onActivated.addListener(() => reportActiveTab());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) reportActiveTab();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) reportActiveTab();
});

async function getSettings() {
  // Prefer local; fall back to sync once for pre-migration installs mid-session.
  let { token = "", port = DEFAULT_PORT, enabled = true } = await chrome.storage.local.get([
    "token",
    "port",
    "enabled",
  ]);
  if (!token) {
    const sync = await chrome.storage.sync.get(["token", "port", "enabled"]);
    if (sync.token) {
      token = sync.token;
      port = sync.port ?? port;
      enabled = sync.enabled !== false;
      await chrome.storage.local.set({ token, port, enabled });
      await chrome.storage.sync.remove(["token", "port", "enabled"]);
    }
  }
  return {
    token: String(token || "").trim(),
    port: Number(port) || DEFAULT_PORT,
    enabled: enabled !== false,
  };
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h;
  } catch {
    return "";
  }
}

async function reportActiveTab() {
  const { token, port, enabled } = await getSettings();
  if (!enabled || !token) {
    setBadge("off");
    return;
  }

  let tab;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = t;
  } catch {
    setBadge("…");
    return;
  }
  if (!tab?.url) {
    setBadge("…");
    return;
  }
  const domain = hostFromUrl(tab.url);
  if (!domain) {
    setBadge("…");
    return;
  }

  const title = (tab.title || "").slice(0, 80);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/tab`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ domain, title }),
    });
    if (res.ok) {
      setBadge("on");
      await chrome.storage.session.set({ lastDomain: domain, lastOk: Date.now() });
    } else if (res.status === 401) {
      setBadge("!");
    } else {
      setBadge("?");
    }
  } catch {
    // Desktop not running — quiet.
    setBadge("×");
  }
}

function setBadge(mode) {
  const map = {
    on: { text: "·", color: "#16a34a" },
    off: { text: "", color: "#9ca3af" },
    "…": { text: "", color: "#9ca3af" },
    "!": { text: "!", color: "#dc2626" },
    "?": { text: "?", color: "#d97706" },
    "×": { text: "×", color: "#9ca3af" },
  };
  const m = map[mode] || map.off;
  chrome.action.setBadgeText({ text: m.text });
  chrome.action.setBadgeBackgroundColor({ color: m.color });
}

// Initial ping when the service worker wakes
reportActiveTab();
