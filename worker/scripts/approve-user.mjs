import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run Wrangler through node: a bare "wrangler" spawn fails on Windows (it is a .cmd shim).
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

// Approve a pending account by email. The new-signup email has a one-click
// approve link; this is the fallback. It does not send the "you're in" email.
const args = process.argv.slice(2);
const local = args.includes("--local");
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--local");
const positional = args.filter((arg) => !arg.startsWith("--"));

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: npm run users:approve -- <email> [--local]");
  process.exit(1);
}

if (unknownFlags.length > 0) usage("Unknown option.");
if (positional.length !== 1) usage("Pass exactly one email.");
const email = positional[0].trim().toLowerCase();
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) usage("That does not look like an email.");

const command = `
INSERT INTO user_approval (userId, requestedAt, approvedAt)
SELECT id, datetime('now'), datetime('now') FROM user WHERE lower(email) = '${email}'
ON CONFLICT(userId) DO UPDATE SET approvedAt = COALESCE(user_approval.approvedAt, excluded.approvedAt);
SELECT u.email, a.approvedAt FROM user u JOIN user_approval a ON a.userId = u.id WHERE lower(u.email) = '${email}';
`.trim();

const result = spawnSync(
  process.execPath,
  [wranglerBin, "d1", "execute", "clocked", local ? "--local" : "--remote", "--command", command, "--yes"],
  { stdio: "inherit", shell: false },
);

if (result.error) {
  console.error(`Could not start Wrangler: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
