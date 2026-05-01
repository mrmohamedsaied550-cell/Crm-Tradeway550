/**
 * P2-08 — timezone helpers.
 *
 * `dayBoundsInTimezone(now, "Africa/Cairo")` returns the
 * `[start, end]` UTC `Date` pair that bounds "today" in the
 * supplied IANA timezone. Used by `LeadsService.listDueToday` so
 * the same server clock can serve admins in different markets and
 * each one sees their own day.
 *
 * Implementation:
 *   - `Intl.DateTimeFormat({ timeZone })` extracts the local
 *     calendar parts (year/month/day) for the supplied moment.
 *   - The day's UTC bounds are computed by converting the local
 *     midnight back to UTC via `Date.UTC(...)` and then offset by
 *     the zone's UTC offset for that calendar date.
 *
 * No external dependency — Node 20's Intl ships full IANA data.
 */

interface DayBounds {
  start: Date;
  end: Date;
}

export function dayBoundsInTimezone(now: Date, timeZone: string): DayBounds {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const partMap = new Map(parts.map((p) => [p.type, p.value]));
  const year = Number.parseInt(partMap.get('year') ?? '0', 10);
  const month = Number.parseInt(partMap.get('month') ?? '0', 10);
  const day = Number.parseInt(partMap.get('day') ?? '0', 10);

  // Find the UTC offset (in ms) for THIS calendar moment in the
  // target zone. We do this by formatting `now` in the zone, then
  // subtracting that wall-clock from `now`'s UTC. The difference is
  // the offset, including DST quirks.
  const wallclockUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number.parseInt(partMap.get('hour') ?? '0', 10),
    Number.parseInt(partMap.get('minute') ?? '0', 10),
    Number.parseInt(partMap.get('second') ?? '0', 10),
  );
  const offsetMs = wallclockUtc - now.getTime();

  // Local midnight as if it were UTC, then shift by the offset to
  // get the actual UTC instant of the local day's start.
  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const start = new Date(localMidnightAsUtc - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}
