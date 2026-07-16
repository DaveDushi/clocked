# Chrome Web Store — publish checklist for clocked

Open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item** → upload the zip from `extension/store/clocked-chrome-store.zip` (or run `extension/store/pack.ps1`).

---

## Package

| Field | Value |
|-------|--------|
| Upload zip | `extension/store/clocked-chrome-store.zip` |
| Manifest version | 3 |
| Extension version | `1.0.0` (in `extension/chrome/manifest.json`) |
| Category | **Productivity** |
| Language | English |

Rebuild the zip after any change:

```powershell
.\extension\store\pack.ps1
```

---

## Store listing (copy-paste)

### Name
```
clocked
```

### Summary (max ~132 chars)
```
Sends the active tab’s site to the clocked desktop app for accurate time attribution. Local only.
```

### Description
```
clocked is an optional companion for the open-source clocked desktop time tracker.

What it does
• When you switch tabs, it tells the clocked tray app which site is focused (hostname only, e.g. github.com).
• The desktop app still owns the clock — unlock, idle, sleep, and pause decide when you are working.
• This makes project/site rollups more accurate than window-title guessing alone.

What it does not do
• Does not start or stop timers by itself
• Does not sync hours to the cloud
• Does not read page content, keystrokes, or form fields
• Does not send full URLs (no path or query string)

Setup
1. Install and run the clocked desktop app (https://clocked.daviddusi.com/download).
2. Create an account, copy your clk_… sync token from the dashboard.
3. Paste that same token into this extension’s Options.
4. Leave the desktop app running while you browse.

Privacy
• Talks only to http://127.0.0.1 on your machine (the desktop bridge).
• Token is stored in chrome.storage.local on this device only.
• Privacy policy: https://clocked.daviddusi.com/privacy/extension

Source: https://github.com/DaveDushi/clocked
```

### Official URL
```
https://clocked.daviddusi.com
```

### Support email
Use your store developer contact email (or the one on the clocked account).

---

## Privacy tab (dashboard)

### Single purpose
```
Report the active browser tab’s hostname to the local clocked desktop app so site time is attributed accurately while the user is already clocked in.
```

### Permission justifications

**tabs**
```
Read the active tab’s URL hostname and short title so we can tell the desktop app which site is focused. We never send the full URL path or query string.
```

**storage**
```
Save the user’s desktop sync token, bridge port, and enabled flag on this device only (chrome.storage.local).
```

**alarms**
```
Wake the service worker about once a minute so a long stay on one tab still reports the current site after Chrome suspends the worker.
```

**Host permission: http://127.0.0.1/**
```
POST the active hostname to the clocked desktop bridge listening on localhost only. No internet hosts are contacted by this extension.
```

### Data usage (checkboxes — typical answers)

| Question | Answer |
|----------|--------|
| Collects user data? | **Yes** — hostname + optional short tab title, only for local bridge |
| Personally identifiable information? | **No** (token is a secret the user pastes; not uploaded by us) |
| Health / financial / auth credentials? | **No** |
| Personal communications? | **No** |
| Location? | **No** |
| Web history? | **Yes** in a limited sense: active tab **hostname** only, while enabled, sent to local desktop |
| User activity? | Active site hostname for local time attribution |
| Website content? | **No** |

### Privacy policy URL
```
https://clocked.daviddusi.com/privacy/extension
```

### Certify remote code
Confirm: **no remote code**. All logic is in the uploaded package. Only local `fetch` to `127.0.0.1`.

---

## Screenshots

Required: at least **one** screenshot (1280×800 or 640×400).

Generated placeholders (replace with real captures if you prefer):

| File | Use |
|------|-----|
| `extension/store/screenshots/01-options-1280x800.png` | Options / token setup |
| `extension/store/screenshots/02-how-it-works-1280x800.png` | How it fits with desktop |

**How to capture real ones (optional polish):**
1. Load unpacked `extension/chrome`
2. Open Options → fill sample token (fake is fine) → screenshot
3. Open popup on a tab → screenshot

Small tile (optional): 440×280 — `extension/store/screenshots/promo-440x280.png` if generated.

---

## Distribution

1. Upload zip → fill listing + privacy as above  
2. Visibility: **Public** (or Unlisted for a soft launch)  
3. Regions: All  
4. Submit for review  

Typical first review: a few hours to a few days.

---

## After approval

1. Copy the store URL, e.g.  
   `https://chromewebstore.google.com/detail/clocked/<id>`
2. Update the landing page “Chrome extension” button to that URL (or keep `/download/extension` as “manual zip”).
3. Optional: Edge Add-ons can reuse the same package.

---

## Smoke test before submit

- [ ] `pack.ps1` builds without errors  
- [ ] Load the **zip contents** (or unpacked `chrome/`) in a clean Chrome profile  
- [ ] Options: save token, Test connection with desktop running  
- [ ] Switch tabs → badge turns green when desktop receives  
- [ ] No network calls except to `127.0.0.1` (check DevTools → Network on the service worker)
