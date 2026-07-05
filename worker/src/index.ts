import { checkAuth } from "./auth";
import { buildAndSendReport } from "./email";
import { handleIngest } from "./ingest";
import { buildReportTsv } from "./report";
import { isFirstOfMonth, previousMonthPeriod } from "./time";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response("clocked-worker ok\n", { status: 200 });
    }

    // Sync endpoint: desktop app pushes completed sessions here.
    if (req.method === "POST" && url.pathname === "/sessions") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      return handleIngest(req, env);
    }

    // Preview the report body without emailing (?period=YYYY-MM, default last).
    if (req.method === "GET" && url.pathname === "/preview") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      const period =
        url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const tsv = await buildReportTsv(env, period);
      return new Response(tsv, { status: 200, headers: { "content-type": "text/plain" } });
    }

    // Manual test trigger: build + send a report now, bypassing the date gate.
    // Optional ?period=YYYY-MM (defaults to previous month). Always `force`.
    if (req.method === "POST" && url.pathname === "/send-test") {
      if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
      const period =
        url.searchParams.get("period") ?? previousMonthPeriod(new Date(), env.REPORT_TZ);
      const result = await buildAndSendReport(env, period, { force: true });
      return json(result, result.ok ? 200 : 500);
    }

    return json({ error: "not found" }, 404);
  },

  // Runs daily (06:00 UTC); only emails on the 1st in REPORT_TZ, for last month.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (!isFirstOfMonth(now, env.REPORT_TZ)) return;
    const period = previousMonthPeriod(now, env.REPORT_TZ);
    ctx.waitUntil(buildAndSendReport(env, period, { force: false }).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
