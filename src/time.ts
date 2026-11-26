/**
 * Time formatting in the configured timezone (TIMEZONE, default Asia/Kolkata).
 *
 * Deliberately depends on nothing but Intl, so the logger can use it too.
 * Storage (Postgres timestamps) stays timezone-neutral; only what humans see
 * — logs, API responses, Telegram messages — is rendered in local time.
 */

const FALLBACK_TZ = 'Asia/Kolkata';
const MAX_CACHED_TIME_ZONES = 16;

function createFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  return { timeZone, formatter };
}

const fallbackFormatter = createFormatter(FALLBACK_TZ);
const formatters = new Map<string, ReturnType<typeof createFormatter>>();

function getFormatter(timeZone: string | undefined) {
  const candidate = (timeZone ?? '').trim() || FALLBACK_TZ;
  if (candidate === FALLBACK_TZ) return fallbackFormatter;
  const cached = formatters.get(candidate);
  if (cached) return cached;

  let entry = fallbackFormatter;
  try {
    entry = createFormatter(candidate);
  } catch {
    // Preserve the fallback for unknown time zones.
  }
  if (formatters.size >= MAX_CACHED_TIME_ZONES) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(candidate, entry);
  return entry;
}

const defaultFormatter = getFormatter(process.env.TIMEZONE);

function parts(date: Date, formatter: Intl.DateTimeFormat): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter.formatToParts(date)) out[p.type] = p.value;
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
export function isoLocal(date: Date = new Date(), timeZone?: string): string {
  const { formatter } = timeZone === undefined ? defaultFormatter : getFormatter(timeZone);
  const p = parts(date, formatter);
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${offsetOf(p.timeZoneName)}`;
}

/** Short human form, e.g. "27 Sep 2026, 13:05 IST" (stable across Node/ICU versions). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function humanLocal(date: Date = new Date(), timeZone?: string): string {
  const { timeZone: tz, formatter } = timeZone === undefined ? defaultFormatter : getFormatter(timeZone);
  const p = parts(date, formatter);
  const month = MONTHS[Number(p.month) - 1] ?? p.month;
  const label = isIndianTimeZone(tz) ? 'IST' : p.timeZoneName ?? tz;
  return `${p.day} ${month} ${p.year}, ${p.hour}:${p.minute} ${label}`;
}

function isIndianTimeZone(timeZone: string): boolean {
  return timeZone === FALLBACK_TZ || timeZone === 'Asia/Calcutta';
}

/** "IST" for Asia/Kolkata; otherwise the numeric offset label (e.g. "GMT+02:00"). */
export function tzLabel(timeZone?: string, date: Date = new Date()): string {
  const { timeZone: tz, formatter } = timeZone === undefined ? defaultFormatter : getFormatter(timeZone);
  return isIndianTimeZone(tz) ? 'IST' : parts(date, formatter).timeZoneName ?? tz;
}

/** Filesystem-safe local stamp, e.g. "2026-09-27T13-05-10-123+0530". */
export function fileStampLocal(date: Date = new Date(), timeZone?: string): string {
  return isoLocal(date, timeZone).replace(/[:.]/g, '-').replace(/([+-])(\d{2})-(\d{2})$/, '$1$2$3');
}
