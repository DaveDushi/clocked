document.getElementById("opts").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

(async () => {
  const { lastDomain = "", lastOk = 0 } = await chrome.storage.session.get([
    "lastDomain",
    "lastOk",
  ]);
  const { token = "", enabled = true } = await chrome.storage.sync.get(["token", "enabled"]);
  const domainEl = document.getElementById("domain");
  const statusEl = document.getElementById("status");

  if (!enabled) {
    domainEl.textContent = "—";
    statusEl.textContent = "Reporting is off.";
    return;
  }
  if (!token) {
    domainEl.textContent = "—";
    statusEl.textContent = "Add your clk_ token in settings.";
    return;
  }
  domainEl.textContent = lastDomain || "waiting for a tab…";
  if (lastOk && Date.now() - lastOk < 30_000) {
    statusEl.textContent = "Desktop received this site.";
  } else {
    statusEl.textContent = "Start the clocked tray app if this stays empty.";
  }
})();
