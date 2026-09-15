/** Calendar-only helpers shared by the selector and server. No host timezone. */
export const PERIOD_RUN_LIMIT = 200;
export const PERIOD_FINDING_LIMIT = 4_000;
export const PERIOD_READ_TIMEOUT_MS = 20_000;
export const PERIOD_QUERY_MESSAGE = "開始日と終了日は実在する日付をYYYY-MM-DDで指定してください。開始日から終了日まで、両端を含め31日以内で指定できます。";
export type WatchPeriod = { from: string; to: string };
export type PeriodQuery =
  | { kind: "select" }
  | { kind: "invalid" }
  | { kind: "valid"; period: WatchPeriod };

const DAY = 86_400_000;
function calendarDate(value: string): Date | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
export function parsePeriodQuery(query: Record<string, string | string[] | undefined>): PeriodQuery {
  const keys = Object.keys(query);
  if (!keys.length) return { kind: "select" };
  if (keys.length !== 2 || !keys.includes("from") || !keys.includes("to") || typeof query.from !== "string" || typeof query.to !== "string") return { kind: "invalid" };
  const from = calendarDate(query.from), to = calendarDate(query.to);
  if (!from || !to || to.getTime() < from.getTime() || (to.getTime() - from.getTime()) / DAY >= 31) return { kind: "invalid" };
  return { kind: "valid", period: { from: query.from, to: query.to } };
}
export function periodBounds(period: WatchPeriod) {
  if (parsePeriodQuery(period).kind !== "valid") throw new Error("invalid period");
  const from = calendarDate(period.from)!, to = calendarDate(period.to)!;
  return {
    fromInclusive: new Date(from.getTime() - 9 * 3_600_000).toISOString(),
    toExclusive: new Date(to.getTime() + DAY - 9 * 3_600_000).toISOString(),
  };
}
export function previousWatchPeriod(preset: "week" | "month", now = new Date()): WatchPeriod {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  const today = calendarDate(`${part("year")}-${part("month")}-${part("day")}`)!;
  if (preset === "week") {
    const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY;
    return { from: new Date(monday - 7 * DAY).toISOString().slice(0, 10), to: new Date(monday - DAY).toISOString().slice(0, 10) };
  }
  today.setUTCDate(1);
  const to = new Date(today.getTime() - DAY).toISOString().slice(0, 10);
  today.setUTCMonth(today.getUTCMonth() - 1);
  return { from: today.toISOString().slice(0, 10), to };
}
export function periodDateTimeLabel(value: string): string {
  const normalized = value.replace(" ", "T").replace(/([+-][0-9]{2})$/, "$1:00");
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(normalized)) + " JST";
}
export function periodCaseId(value: string): number | null {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2_147_483_647 ? Number(value) : null;
}
export class PeriodReportLimitError extends Error {
  constructor() { super("period_report_limit"); }
}
