/** Publication calendar contract for the standard service; independent of run dates. */
export type PublicationPeriod = Readonly<{ from: string; to: string }>;
export type HolidayCalendar = Readonly<{
  from: string;
  to: string;
  holidays: readonly string[];
  source: string;
  verifiedOn: string;
}>;
export class ManagedPeriodError extends Error {
  constructor(readonly code: "invalid_date" | "invalid_period" | "calendar_unconfirmed") {
    super(code);
  }
}
const DAY = 86_400_000;
export function managedDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) throw new ManagedPeriodError("invalid_date");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ManagedPeriodError("invalid_date");
  return date;
}
const iso = (value: Date) => value.toISOString().slice(0, 10);
export function shiftManagedDate(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new ManagedPeriodError("invalid_date");
  const result = new Date(managedDate(value).getTime() + days * DAY);
  if (!Number.isFinite(result.getTime())) throw new ManagedPeriodError("invalid_date");
  const day = iso(result);
  managedDate(day);
  return day;
}
/** The 25th is a publication boundary even when delivery moves for a holiday. */
export function firstManagedPeriod(monitoringStartsOn: string): PublicationPeriod {
  const end = managedDate(monitoringStartsOn);
  const nextMonth = end.getUTCDate() > 25;
  end.setUTCDate(25);
  if (nextMonth) end.setUTCMonth(end.getUTCMonth() + 1);
  managedDate(iso(end));
  return { from: monitoringStartsOn, to: iso(end) };
}
export function nextManagedPeriod(previous: PublicationPeriod): PublicationPeriod {
  validateManagedPeriod(previous);
  return firstManagedPeriod(shiftManagedDate(previous.to, 1));
}
export function validateManagedPeriod(period: PublicationPeriod): void {
  managedDate(period.from); managedDate(period.to);
  if (firstManagedPeriod(period.from).to !== period.to) throw new ManagedPeriodError("invalid_period");
}
/** Assign using original publication date, including a late detected publication. */
export function managedPeriodForPublication(monitoringStartsOn: string, publishedOn: string): PublicationPeriod | null {
  managedDate(publishedOn);
  const initial = firstManagedPeriod(monitoringStartsOn);
  if (publishedOn < monitoringStartsOn) return null;
  if (publishedOn <= initial.to) return initial;
  const end = managedDate(publishedOn);
  const nextMonth = end.getUTCDate() > 25;
  end.setUTCDate(25);
  if (nextMonth) end.setUTCMonth(end.getUTCMonth() + 1);
  const previousEnd = new Date(end);
  previousEnd.setUTCMonth(previousEnd.getUTCMonth() - 1);
  return { from: shiftManagedDate(iso(previousEnd), 1), to: iso(end) };
}
export function managedJstDate(instant: Date): string {
  if (!Number.isFinite(instant.getTime())) throw new ManagedPeriodError("invalid_date");
  const value = iso(new Date(instant.getTime() + 9 * 3_600_000));
  managedDate(value);
  return value;
}
export function previousBusinessDay(day: string, calendar: HolidayCalendar): string {
  managedDate(day); managedDate(calendar.from); managedDate(calendar.to); managedDate(calendar.verifiedOn);
  if (calendar.from > calendar.to || !calendar.source.trim() || calendar.holidays.length > 400) throw new ManagedPeriodError("calendar_unconfirmed");
  const holidays = new Set(calendar.holidays);
  for (const holiday of holidays) {
    managedDate(holiday);
    if (holiday < calendar.from || holiday > calendar.to) throw new ManagedPeriodError("calendar_unconfirmed");
  }
  let result = day;
  for (let n = 0; n < 31; n++) {
    if (result < calendar.from || result > calendar.to) throw new ManagedPeriodError("calendar_unconfirmed");
    const weekday = managedDate(result).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(result)) return result;
    result = shiftManagedDate(result, -1);
  }
  throw new ManagedPeriodError("calendar_unconfirmed");
}
export function managedDeliveryDueOn(period: PublicationPeriod, calendar: HolidayCalendar): string {
  validateManagedPeriod(period);
  const date = managedDate(period.to);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return previousBusinessDay(iso(date), calendar);
}
/** Retain through end-date + 90 calendar days; delete only the following JST day. */
export function managedDeletionEligibleOn(contractEndsOn: string): string {
  return shiftManagedDate(contractEndsOn, 91);
}

// Cabinet Office published holidays including substitute/citizen holidays.
// Verified 2026-09-23. Unknown future years must be explicitly updated from the source.
export const JAPAN_HOLIDAYS: HolidayCalendar = Object.freeze({
  from: "2026-01-01", to: "2027-12-31", verifiedOn: "2026-09-23",
  source: "https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html",
  holidays: Object.freeze([
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
    "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11",
    "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22",
    "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11",
    "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
  ]),
});
