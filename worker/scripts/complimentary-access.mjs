import { spawnSync } from "node:child_process";

const [action, ...args] = process.argv.slice(2);
const local = args.includes("--local");
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--local");
const positional = args.filter((arg) => !arg.startsWith("--"));
const rawEmail = positional[0];

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: npm run access:grant -- EMAIL [--local]\n" +
      "       npm run access:revoke -- EMAIL [--local]\n" +
      "       npm run access:list -- [--local]",
  );
  process.exit(1);
}

if (!new Set(["grant", "revoke", "list"]).has(action)) usage("Unknown action.");
if (unknownFlags.length > 0) usage("Unknown option.");
if (positional.length > (action === "list" ? 0 : 1)) usage("Too many arguments.");

let command;
if (action === "list") {
  command =
    "SELECT email, datetime(createdAt / 1000, 'unixepoch') AS grantedAt " +
    "FROM complimentary_access ORDER BY email";
} else {
  if (!rawEmail) usage("Email is required.");
  const email = rawEmail.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    usage("Enter a valid email address.");
  }
  const sqlEmail = email.replaceAll("'", "''");
  if (action === "grant") {
    command =
      `INSERT INTO complimentary_access (email, createdAt) VALUES ('${sqlEmail}', ${Date.now()}) ` +
      "ON CONFLICT(email) DO UPDATE SET createdAt = excluded.createdAt";
  } else {
    command = `DELETE FROM complimentary_access WHERE email = '${sqlEmail}'`;
  }
}

const result = spawnSync(
  "wrangler",
  ["d1", "execute", "clocked", local ? "--local" : "--remote", "--command", command, "--yes"],
  { stdio: "inherit", shell: false },
);

if (result.error) {
  console.error(`Could not start Wrangler: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
