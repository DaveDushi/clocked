import assert from "node:assert/strict";
import { test } from "node:test";
import { read, utils } from "xlsx";
import { buildTeamWorkbook } from "../.tmp-test/team-workbook.js";

test("Excel tabs remain unique and valid while long durations and totals survive export", () => {
  const names = ['Summary', 'summary', 'A/B:C*D?E[F]G\\H', 'Same employee name longer than thirty one characters', 'Same employee name longer than thirty one characters'];
  const members = names.map((name, i) => ({ name, email: `member-${i}@example.test`,
    csv: 'Date,Clock In,Clock Out,Breaks,Hours Worked\n"Tuesday, September 1, 2026",09:00,17:00,,8:00\n,,,Total,168:30\n',
    report: { totalMinutes: 10110, activeDays: 22, days: [] },
  }));
  const artifact = buildTeamWorkbook({ title: 'Team - September 2026', timezone: 'UTC', members });
  const book = read(artifact.content, { type: 'array' });
  assert.equal(book.SheetNames.length, 6);
  assert.equal(new Set(book.SheetNames.map((name) => name.toLowerCase())).size, 6);
  assert.ok(book.SheetNames.every((name) => name.length <= 31 && !/[\[\]:*?/\\]/.test(name)));
  const rows = utils.sheet_to_json(book.Sheets.Summary, { header: 1, raw: false });
  assert.equal(rows[4][2], '168:30');
  assert.equal(rows[9][2], '842:30');
  assert.equal(book.Sheets.Summary.C10.f, 'SUM(C5:C9)');
  assert.equal(artifact.sheets[0].rows[4][2], '168:30');
});
