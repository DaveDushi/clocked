import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// Run the real migrations and SQL while exposing D1's statement interface.
export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const DB = {
    async exec(sql) { sqlite.exec(sql); },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() {
          const results = statement.all(...values);
          const meta = sqlite.prepare("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").get();
          return { results, meta };
        },
        async run() { return { meta: statement.run(...values) }; },
      };
    },
  };
  return { DB, sqlite };
}
