import { spawnSync } from "node:child_process";

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
  u.createdAt,
  COALESCE(GROUP_CONCAT(DISTINCT o.name), '') AS organizations,
  COALESCE(GROUP_CONCAT(DISTINCT m.role), '') AS roles,
  CASE
    WHEN ca.email IS NOT NULL THEN 'complimentary'
    WHEN EXISTS (
      SELECT 1
        FROM member paid_member
        JOIN org_billing paid_billing
          ON paid_billing.organizationId = paid_member.organizationId
       WHERE paid_member.userId = u.id
         AND paid_billing.status IN ('active', 'trialing', 'past_due')
    ) THEN 'billing'
    ELSE 'none'
  END AS access
FROM user u
LEFT JOIN member m ON m.userId = u.id
LEFT JOIN organization o ON o.id = m.organizationId
LEFT JOIN complimentary_access ca ON ca.email = lower(trim(u.email))
GROUP BY u.id, u.email, u.name, u.emailVerified, u.createdAt, ca.email
ORDER BY u.createdAt DESC, u.email;
`.trim();

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
