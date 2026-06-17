/** Local-calendar date helpers (whole-app review P2): `toISOString()`
 * renders UTC — for any US-evening user that's already tomorrow, so tasks
 * due today filed under "Overdue" and "snooze until tomorrow" reappeared
 * the same evening. The noon trick (InsightsView's original): build a Date
 * at local noon, then the UTC date is guaranteed to match the local date.
 */
export function localISODate(d: Date = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)
    .toISOString()
    .slice(0, 10);
}

/** The local date N days from `d`, as YYYY-MM-DD. */
export function localISODatePlusDays(days: number, d: Date = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12)
    .toISOString()
    .slice(0, 10);
}
