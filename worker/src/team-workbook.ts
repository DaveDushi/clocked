import { read, utils, writeXLSX, type CellObject } from "xlsx";
import type { HoursReport } from "./report.js";

export interface TeamSheetPreview { name: string; rows: string[][] }
export interface WorkbookMember { name: string; email: string; csv: string; report: HoursReport }

export function timesheetCsvRows(csv: string): string[][] {
  if (!csv) return [];
  const parsed = read(csv, { type: "string", raw: true });
  return utils.sheet_to_json<string[]>(parsed.Sheets[parsed.SheetNames[0]], { header: 1, defval: "", blankrows: false });
}

const duration = (minutes: number): CellObject => ({ t: "n", v: minutes / 1440, z: "[h]:mm" });

export function buildTeamWorkbook({ title, timezone, members }: {
  title: string; timezone: string; members: WorkbookMember[];
}): { content: Uint8Array; sheets: TeamSheetPreview[] } {
  const workbook = utils.book_new();
  const summary = utils.aoa_to_sheet([
    [title], ["Timezone", timezone], [],
    ["Employee", "Email", "Worked hours", "Recorded days", "Paid lunch", "Overtime", "Status"],
    ...members.map((m) => [m.name, m.email, duration(m.report.totalMinutes), m.report.activeDays,
      duration(m.report.paidLunchMinutes ?? 0), duration(m.report.overtimeMinutes ?? 0), m.csv ? "Recorded" : "No sessions recorded"]),
    ["Team total", "", duration(0), 0, duration(0), duration(0)],
  ]);
  const totalRow = members.length + 5;
  for (const [column, value] of [
    ["C", members.reduce((sum, m) => sum + m.report.totalMinutes / 1440, 0)],
    ["D", members.reduce((sum, m) => sum + m.report.activeDays, 0)],
    ["E", members.reduce((sum, m) => sum + (m.report.paidLunchMinutes ?? 0) / 1440, 0)],
    ["F", members.reduce((sum, m) => sum + (m.report.overtimeMinutes ?? 0) / 1440, 0)],
  ] satisfies [string, number][]) {
    summary[`${column}${totalRow}`] = { t: "n", v: value, f: members.length ? `SUM(${column}5:${column}${totalRow - 1})` : "0",
      ...(column !== "D" ? { z: "[h]:mm" } : {}) };
  }
  summary["!cols"] = [{ wch: 28 }, { wch: 36 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 24 }];
  summary["!autofilter"] = { ref: `A4:G${totalRow - 1}` };
  utils.book_append_sheet(workbook, summary, "Summary");
  const used = new Set(["summary", "history"]);
  for (const member of members) {
    const base = (member.name || member.email).replace(/[\x00-\x1f\[\]:*?/\\]/g, " ").trim().replace(/^'+|'+$/g, "") || "Employee";
    let name = base.slice(0, 31).replace(/'+$/g, "");
    let suffix = 2;
    while (used.has(name.toLowerCase())) { const tail = ` (${suffix++})`; name = base.slice(0, 31 - tail.length) + tail; }
    used.add(name.toLowerCase());
    const rows = timesheetCsvRows(member.csv);
    const headers = rows[0] ?? ["Date", "Clock In", "Clock Out", "Breaks", "Hours Worked"];
    const data = rows.length ? rows.slice(1).map((row) => row.map((value, i) => {
      if (!["Hours Worked", "Paid Lunch", "Regular Hours", "Overtime"].includes(headers[i])) return value;
      const match = /^(\d+):(\d{2})$/.exec(value);
      return match ? duration(Number(match[1]) * 60 + Number(match[2])) : value;
    })) : [["No sessions recorded"], ["", "", "", "Total", duration(0)]];
    const sheet = utils.aoa_to_sheet([[member.name], [member.email], [title], ["Timezone", timezone], headers, ...data]);
    sheet["!cols"] = headers.map((header, i) => ({ wch: i === 0 ? 34 : header === "Breaks" ? 42 : 18 }));
    sheet["!autofilter"] = { ref: `A5:${utils.encode_col(headers.length - 1)}${Math.max(5, data.length + 4)}` };
    utils.book_append_sheet(workbook, sheet, name);
  }
  const sheets = workbook.SheetNames.map((name) => ({ name,
    rows: utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "" }),
  }));
  return { content: new Uint8Array(writeXLSX(workbook, { type: "array", compression: true })), sheets };
}
