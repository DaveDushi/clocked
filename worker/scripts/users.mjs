import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run Wrangler through node: a bare "wrangler" spawn fails on Windows (it is a .cmd shim).
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

const args = process.argv.slice(2);
const local = args.includes("--local");
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--local");
const positional = args.filter((arg) => !arg.startsWith("--"));

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: npm run users:list -- [--local]");
  process.exit(1);
}

if (unknownFlags.length > 0) usage("Unknown option.");
if (positional.length > 0) usage("This command does not accept positional arguments.");

const command = `
SELECT
  u.email,
  u.name,
  CASE WHEN u.emailVerified = 1 THEN 'verified' ELSE 'unverified' END AS emailStatus,
  CASE WHEN a.approvedAt IS NOT NULL THEN 'approved' ELSE 'pending' END AS approval,
  u.createdAt,
  COALESCE(GROUP_CONCAT(DISTINCT o.name), '') AS organizations,
  COALESCE(GROUP_CONCAT(DISTINCT m.role), '') AS roles
FROM user u
LEFT JOIN user_approval a ON a.userId = u.id
LEFT JOIN member m ON m.userId = u.id
LEFT JOIN organization o ON o.id = m.organizationId
GROUP BY u.id, u.email, u.name, u.emailVerified, a.approvedAt, u.createdAt
ORDER BY u.createdAt DESC, u.email;
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
