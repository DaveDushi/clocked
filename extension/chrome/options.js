const $ = (id) => document.getElementById(id);

/** Load settings from local storage (migrate from sync once if needed). */
async function loadSettings() {
  let data = await chrome.storage.local.get(["token", "port", "enabled"]);
  if (!data.token) {
    const sync = await chrome.storage.sync.get(["token", "port", "enabled"]);
    if (sync.token) {
      data = {
        token: sync.token,
        port: sync.port ?? 19532,
        enabled: sync.enabled !== false,
      };
      await chrome.storage.local.set(data);
      await chrome.storage.sync.remove(["token", "port", "enabled"]);
    }
  }
  return {
    token: data.token || "",
    port: data.port ?? 19532,
    enabled: data.enabled !== false,
  };
}

async function load() {
  const { token, port, enabled } = await loadSettings();
  $("token").value = token;
  $("port").value = port || 19532;
  $("enabled").checked = enabled !== false;
}

$("save").onclick = async () => {
  const token = $("token").value.trim();
  const port = Number($("port").value) || 19532;
  const enabled = $("enabled").checked;
  // Local only — never chrome.storage.sync (avoids uploading clk_ to Google).
  await chrome.storage.local.set({ token, port, enabled });
  await chrome.storage.sync.remove(["token", "port", "enabled"]);
  msg("Saved on this device only.", true);
};

$("test").onclick = async () => {
  const token = $("token").value.trim();
  const port = Number($("port").value) || 19532;
  if (!token) {
    msg("Paste your clk_ token first.", false);
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      msg("Connected to clocked on this PC.", true);
    } else if (res.status === 401) {
      msg("Token rejected — paste the same token as desktop Settings.", false);
    } else {
      msg(`Desktop responded HTTP ${res.status}.`, false);
    }
  } catch {
    msg("Can't reach desktop. Is clocked running?", false);
  }
};

function msg(text, ok) {
  const el = $("msg");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
}

load();
