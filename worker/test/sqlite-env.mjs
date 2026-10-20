import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

/** D1-shaped adapter over real SQLite. Executes production SQL and migrations. */
export function sqliteEnv(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  for (const id of ["alice", "bob", "unpaid"]) {
    sqlite.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
                    VALUES (?, ?, ?, 1, 0, 0)`).run(id, id, `${id}@example.test`);
  }
  for (const id of ["alice", "bob"]) {
    sqlite.prepare("INSERT INTO complimentary_access (email, createdAt) VALUES (?, ?)")
      .run(`${id}@example.test`, Date.now());
  }
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        execute() {
          const stmt = sqlite.prepare(sql);
          const results = stmt.columns().length ? stmt.all(...args).map((r) => ({ ...r })) : [];
          if (!stmt.columns().length) stmt.run(...args);
          return { results, success: true, meta: { changes: sqlite.prepare("SELECT changes() AS n").get().n } };
        },
        async all() { return this.execute(); },
        async first() { return this.execute().results[0] ?? null; },
        async run() { return this.execute(); },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((stmt) => stmt.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { DB: db, REPORT_TZ: "UTC", sqlite };
}
