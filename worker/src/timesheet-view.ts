import type { HoursReport, SessionSegment } from "./report";

type ViewData = HoursReport & {
  sessions: SessionSegment[];
  projects?: { project: string; minutes: number }[];
};

interface Target {
  key: string;
  period: string;
  hoursUrl: string;
  editUrl: string;
  label: string;
}

interface Options {
  request: (url: string, init?: RequestInit) => Promise<Response>;
  loading: (target: Target, retained: boolean) => void;
  render: (data: ViewData, target: Target) => void;
  selection: (day: string, data: ViewData | null) => void;
  busy: (pending: boolean) => void;
  message: (text: string, retry?: () => void) => void;
}

// Serialized into the dashboard, so this function must keep its runtime dependencies inside it.
export function createTimesheetView(options: Options) {
  let target: Target | null = null;
  let data: ViewData | null = null;
  let day = "";
  let revision = 0;
  let generation = 0;
  const pending = new Set<string>();
  const saved = new Set<string>();

  const view = {
    select(date: string) {
      day = data?.days.some((row) => row.date === date) ? date : "";
      options.selection(day, data);
    },

    async load(next: Target): Promise<void> {
      const same = target?.key === next.key;
      target = next;
      if (!same) {
        data = null;
        day = "";
        options.selection("", null);
      }
      const requestRevision = ++revision;
      options.loading(next, data !== null);
      options.busy(data === null || pending.has(generation + ":" + next.editUrl));
      options.message("");
      try {
        const response = await options.request(next.hoursUrl);
        if (!response.ok) throw new Error("Could not load timesheet.");
        const result = await response.json<ViewData>();
        if (requestRevision !== revision) return;
        data = result;
        options.render(result, next);
        view.select(day);
        options.busy(pending.has(generation + ":" + next.editUrl));
        options.message(saved.delete(next.key) ? "Saved." : "");
      } catch {
        if (requestRevision !== revision) return;
        options.message(saved.has(next.key)
          ? "Saved, but refresh failed. Displayed hours may be out of date."
          : "Could not load timesheet.", () => { void view.load(next); });
      }
    },

    async edit(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>): Promise<boolean> {
      if (!target || !data || pending.has(generation + ":" + target.editUrl)) return false;
      const original = target;
      const editGeneration = generation;
      const pendingKey = generation + ":" + original.editUrl;
      pending.add(pendingKey);
      options.busy(true);
      options.message("");
      try {
        const response = await options.request(original.editUrl, { method, body: JSON.stringify(body) });
        if (!response.ok) {
          const error = await response.json<{ error?: string }>().catch(() => ({}));
          throw new Error("error" in error && error.error ? error.error : "Could not save session.");
        }
        if (editGeneration !== generation) return true;
        saved.add(original.key);
        if (target?.editUrl === original.editUrl) {
          saved.add(target.key);
          await view.load(target);
        }
        return true;
      } catch (error) {
        if (editGeneration === generation && target?.key === original.key) {
          options.message(error instanceof Error ? error.message : "Could not save session.");
        }
        return false;
      } finally {
        pending.delete(pendingKey);
        if (editGeneration === generation) options.busy(data === null || !!target && pending.has(generation + ":" + target.editUrl));
      }
    },

    clear(reset = false) {
      ++revision;
      if (reset) ++generation;
      target = null;
      data = null;
      day = "";
      if (reset) saved.clear();
      options.selection("", null);
    }
  };
  return view;
}
