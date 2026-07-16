# clocked Chrome extension

## What it does (and does not)

| Does | Does not |
|------|----------|
| Tells the **desktop app** which site is active (`github.com`) | Start/stop timers |
| Helps attribute *time already tracked* to the right site | Sync hours to the cloud by itself |
| Works only while **clocked is running** and you’re clocked in | Replace the tray app |

**Time still comes from the desktop app** (unlock / idle / focus). The extension only answers: “in this browser window, which site is focused?”

## How it fits together

```
Chrome tab → extension (every tab switch + ~1 min heartbeat)
                │  POST http://127.0.0.1:19532/v1/tab
                │  Authorization: Bearer clk_…
                ▼
         clocked tray (bridge)
                │  remembers domain for ~90s
                ▼
   every 5s while clocked in + Chrome focused:
         record time against that domain → local SQLite
                │
                ▼ (optional)
         cloud sync: presence sessions + project/app day totals
         (not raw tab history)
```

## Privacy

- Local only: `http://127.0.0.1:19532` (never the open internet).
- Sends **hostname + short title**, never full URL path/query, never page content.
- Auth: same `clk_…` token as desktop Settings (required so random pages can’t POST junk).
- Token is stored in **local** extension storage only (not Chrome sync) so it stays on this PC.

## Install (unpacked)

1. Run **clocked** and paste your sync token in Settings.
2. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked**.
3. Select this folder (`extension/chrome`).
4. Extension **Options** → paste the same `clk_…` → **Test connection**.

Badge: green `·` = desktop got a tab ping · `!` = bad token · `×` = tray not running.

## Desktop side

The tray always starts the bridge on `127.0.0.1:19532`. Requests without a matching bearer are rejected.
