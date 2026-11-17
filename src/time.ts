/**
 * Time formatting in the configured timezone (TIMEZONE, default Asia/Kolkata).
 *
 * Deliberately depends on nothing but Intl, so the logger can use it too.
 * Storage (Postgres timestamps) stays timezone-neutral; only what humans see
 * — logs, API responses, Telegram messages — is rendered in local time.
 */

const FALLBACK_TZ = 'Asia/Kolkata';

function resolveTimeZone(timeZone: string | undefined): string {
  const candidate = (timeZone ?? '').trim() || FALLBACK_TZ;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TZ;
  }
}

const DEFAULT_TZ = resolveTimeZone(process.env.TIMEZONE);

function parts(date: Date, timeZone: string): Record<string, string> {
  const tz = resolveTimeZone(timeZone);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "GMT+05:30" → "+05:30"; "GMT" → "+00:00". */
function offsetOf(tzName: string | undefined): string {
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(tzName ?? '');
  if (!m) return '+00:00';
  return `${m[1]}:${m[2] ?? '00'}`;
}

/**
 * ISO-8601 with the local offset, e.g. "2026-09-27T13:05:10.123+05:30".
 * Still machine-parseable (`new Date(s)` gives the same instant).
 */
export function isoLocal(date: Date = new Date(), timeZone: string = DEFAULT_TZ): string {
  const p = parts(date, timeZone);
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${offsetOf(p.timeZoneName)}`;
}

/** Short human form, e.g. "27 Sep 2026, 13:05 IST" (stable across Node/ICU versions). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function humanLocal(date: Date = new Date(), timeZone: string = DEFAULT_TZ): string {
  const tz = resolveTimeZone(timeZone);
  const p = parts(date, tz);
  const month = MONTHS[Number(p.month) - 1] ?? p.month;
  return `${p.day} ${month} ${p.year}, ${p.hour}:${p.minute} ${tzLabel(tz, date)}`;
}

/** "IST" for Asia/Kolkata; otherwise the numeric offset label (e.g. "GMT+02:00"). */
export function tzLabel(timeZone: string = DEFAULT_TZ, date: Date = new Date()): string {
  const tz = resolveTimeZone(timeZone);
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
  const p = parts(date, tz);
  return p.timeZoneName ?? tz;
}

/** Filesystem-safe local stamp, e.g. "2026-09-27T13-05-10-123+0530". */
export function fileStampLocal(date: Date = new Date(), timeZone: string = DEFAULT_TZ): string {
  return isoLocal(date, timeZone).replace(/[:.]/g, '-').replace(/([+-])(\d{2})-(\d{2})$/, '$1$2$3');
}
