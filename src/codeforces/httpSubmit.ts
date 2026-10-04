import { Impit } from 'impit';
import { logger } from '../logger';
import { CodeforcesSubmission, fetchContestStatus, fetchUserStatus } from './api';
import { SourceIndexEntry } from './sourceRepo';
import { StoredCodeforcesState } from './storage';

/**
 * Browserless Codeforces submission — the fast path. The browser transport in
 * ./submission.ts takes over whenever the edge refuses a POST.
 *
 * Cloudflare decides by TLS/HTTP2 fingerprint. Headless Chromium and Chrome
 * profiles get a 403 "Just a moment..." challenge from datacenter IPs. A Firefox
 * fingerprint is served normally for GETs, but NOT for POSTs: measured from a
 * datacenter IP, every POST to codeforces.com — including to a path that does
 * not exist and to the site root — comes back 302 → "/". A client that never
 * passed Cloudflare's challenge simply cannot POST, which is why no payload or
 * endpoint change ever got through. So this replay works only if the edge
 * relents; otherwise the caller falls back to a real Firefox.
 *
 *   GET  /contest/<id>/submit            -> csrf_token + language list
 *   POST <the form's own action>
 *        csrf_token, ftaa, bfaa, action=submitSolutionFormSubmitted,
 *        submittedProblemIndex, programTypeId, source, tabSize, _tta
 *
 * and read the verdict from the official API.
 */

const BASE = 'https://codeforces.com';
const CHALLENGE_RE = /<title>\s*Just a moment|cf-chl|challenge-platform\/h\/[a-z]\/orchestrate/i;
const PENDING = new Set(['TESTING', 'QUEUE', 'QUEUED', undefined, null]);
const VERDICT_WINDOW_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

export type HttpSubmitResult =
  | { ok: true; submissionId: string; verdict: string }
  | {
      ok: false;
      kind: 'signed-out' | 'blocked' | 'rejected' | 'judge-timeout' | 'error';
      error: string;
      submissionId?: string | null;
      verdict?: string | null;
    };

export interface FormPage {
  /** The action attribute exactly as rendered, for logging. */
  actionRaw: string;
  /** Action resolved the way a browser resolves it — against the PAGE url, never
   *  against the origin. Codeforces renders the submit form with an action that
   *  keeps only the query ("?csrf_token=<token>"), so it preserves the submit
   *  path only when resolved against the page it sits on. Resolved against the
   *  origin it becomes https://codeforces.com/?csrf_token=… and the POST is
   *  answered with 302 → "/". */
  action: string;
  hidden: Record<string, string>;
  csrf: string | null;
  signedInHandle: string | null;
  problemIndexes: string[];
  languages: Array<{ value: string; text: string }>;
  expectsProblemCode: boolean;
  hasSubmitForm: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Cookie header for codeforces.com from the stored Cookie-Editor / storageState export. */
export function cookieHeader(state: StoredCodeforcesState, nowSeconds = Date.now() / 1000): string {
  const byName = new Map<string, string>();
  for (const c of state.cookies) {
    if (!/(^|\.)codeforces\.com$/i.test(c.domain.replace(/^\./, ''))) continue;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSeconds) continue;
    // Cloudflare clearance is bound to the exporting browser's fingerprint; ours differs.
    if (/^(cf_clearance|__cf_bm|_cfuvid)$/i.test(c.name)) continue;
    byName.set(c.name, c.value);
  }
  return [...byName].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Codeforces' own form signature: Codeforces.tta() == ca76fd64a80cdc35(cookie "39ce7"). */
export function computeTta(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h + (i + 1) * (i + 2) * seed.charCodeAt(i)) % 1009;
    if (i % 3 === 0) h++;
    if (i % 2 === 0) h *= 2;
    if (i > 0) h -= Math.floor(seed.charCodeAt(Math.floor(i / 2)) / 2) * (h % 5);
    while (h < 0) h += 1009;
    while (h >= 1009) h -= 1009;
  }
  return h;
}

/** Browser-like 18-char fingerprint id (the page generates ftaa the same way). */
function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function randomFtaa(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 18; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

export function parseSubmitPage(html: string, pageUrl: string = BASE): FormPage {
  const csrf =
    /name=['"]csrf_token['"][^>]*value=['"]([0-9a-f]{16,})['"]/i.exec(html)?.[1] ??
    /name=["']X-Csrf-Token["'][^>]*content=["']([0-9a-f]{16,})["']/i.exec(html)?.[1] ??
    /data-csrf=['"]([0-9a-f]{16,})['"]/i.exec(html)?.[1] ??
    null;

  const at = html.search(/class=["']lang-chooser["']/i);
  const menu = at >= 0 ? html.indexOf('menu-box', at) : -1;
  const header = at >= 0 ? html.slice(at, menu > at ? menu : at + 2500) : '';
  const signedIn = /\/logout/i.test(header);
  const signedInHandle = signedIn ? (/href=["']\/profile\/([^"'/?#]+)["']/i.exec(header)?.[1] ?? null) : null;

  const formTag = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].find((m) =>
    /name=["']source["']/.test(m[1] ?? ''),
  );
  const formBody = formTag?.[1] ?? html;
  const actionRaw = /<form\b[^>]*\baction=["']([^"']*)["']/i.exec(formTag?.[0] ?? '')?.[1] ?? '';
  const hidden: Record<string, string> = {};
  for (const input of formBody.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    if (!/type=["']hidden["']/i.test(tag)) continue;
    const name = /name=["']([^"']+)["']/i.exec(tag)?.[1];
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (name) hidden[decode(name)] = decode(value);
  }

  const select = (name: string) =>
    new RegExp(`<select[^>]*name=["']${name}["'][^>]*>([\\s\\S]*?)</select>`, 'i').exec(html)?.[1] ?? '';
  const options = (block: string) =>
    [...block.matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)].map((m) => ({
      value: decode(m[1]!.trim()),
      text: decode(m[2]!.replace(/<[^>]+>/g, '').trim()),
    }));

  return {
    actionRaw,
    action: actionRaw ? new URL(decode(actionRaw), pageUrl).toString() : '',
    hidden,
    csrf: csrf ?? hidden['csrf_token'] ?? null,
    signedInHandle: signedInHandle ? decodeURIComponent(signedInHandle) : null,
    problemIndexes: options(select('submittedProblemIndex'))
      .map((o) => o.value)
      .filter(Boolean),
    languages: options(select('programTypeId')).filter((o) => o.value),
    expectsProblemCode: /name=["']submittedProblemCode["']/i.test(formBody),
    hasSubmitForm: formTag !== undefined,
  };
}

/** Newest GNU G++ for C++ (91 = G++23 in the capture), PyPy 3 / Python 3 for Python. */
export function pickLanguage(
  languages: Array<{ value: string; text: string }>,
  language: 'cpp' | 'python',
): string | null {
  if (language === 'python') {
    return (
      languages.find((o) => /PyPy\s*3/i.test(o.text))?.value ??
      languages.find((o) => /Python\s*3/i.test(o.text))?.value ??
      null
    );
  }
  const gpp = languages
    .map((o) => ({ o, v: Number(/G\+\+\s*(\d+)/i.exec(o.text)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  return gpp[0]?.o.value ?? languages.find((o) => /C\+\+/i.test(o.text))?.value ?? (languages.length ? null : '91');
}

/** Error text Codeforces renders next to the form when it refuses a submission. */
export function extractFormError(html: string): string | null {
  for (const m of html.matchAll(/<span[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = m[1]!.replace(/<[^>]+>/g, '').trim();
    if (text) return decode(text);
  }
  return null;
}

export function submitPaths(entry: Pick<SourceIndexEntry, 'contestId' | 'problemIndex' | 'gym'>): string {
  return entry.gym ? `/gym/${entry.contestId}/submit` : `/contest/${entry.contestId}/submit`;
}

// ---------------------------------------------------------------------------
// Network flow
// ---------------------------------------------------------------------------

export interface HttpClient {
  jar?: Map<string, string>;
  get(path: string): Promise<{ status: number; location: string | null; body: string; setCookies: string[] }>;
  post(path: string, form: URLSearchParams, referer: string): Promise<{ status: number; location: string | null; body: string; setCookies: string[] }>;
}

export function createClient(state: StoredCodeforcesState): HttpClient {
  const impit = new Impit({ browser: 'firefox', followRedirects: false, timeout: 45_000 });
  const jar = new Map<string, string>(
    cookieHeader(state)
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as [string, string]),
  );
  const absorb = (headers: Headers): string[] => {
    const list =
      typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : (headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_-]+=)/).filter(Boolean);
    for (const raw of list) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
    return list;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const run = async (path: string, init: { method: 'GET' | 'POST'; body?: string; referer?: string }) => {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    const res = await impit.fetch(url, {
      method: init.method,
      redirect: 'manual',
      headers: {
        cookie: cookie(),
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.5',
        ...(init.body
          ? { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, referer: init.referer ?? url }
          : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
    const setCookies = absorb(res.headers);
    return { status: res.status, location: res.headers.get('location'), body: await res.text(), setCookies };
  };
  return {
    get: (path) => run(path, { method: 'GET' }),
    post: (path, form, referer) => run(path, { method: 'POST', body: form.toString(), referer }),
    jar,
  };
}

export async function submitViaHttp(
  state: StoredCodeforcesState,
  expectedHandle: string | null,
  entry: SourceIndexEntry,
  code: string,
  deps: { client?: HttpClient; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<HttpSubmitResult & { handle?: string }> {
  if (entry.contestId === undefined || !entry.problemIndex) {
    return { ok: false, kind: 'error', error: 'source entry has no contestId/problemIndex' };
  }
  const client = deps.client ?? createClient(state);
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  // A finished contest refuses POSTs to /contest/<id>/submit by redirecting to "/",
  // so the problemset endpoint is tried as well when that happens.
  const candidates = entry.gym
    ? [`/gym/${entry.contestId}/submit`]
    : [`/contest/${entry.contestId}/submit`, `/problemset/submit/${entry.contestId}/${entry.problemIndex}`];
  const attempts: string[] = [];

  for (const path of candidates) {
    const pageUrl = `${BASE}${path}`;
    const page = await client.get(path);
    if (page.status === 403 || CHALLENGE_RE.test(page.body)) {
      return { ok: false, kind: 'blocked', error: `Cloudflare challenged GET ${path} (HTTP ${page.status})` };
    }
    if (page.status >= 300 && page.status < 400) {
      if (page.location && /\/enter(?:[/?#]|$)/i.test(page.location)) {
        return {
          ok: false,
          kind: 'signed-out',
          error: `Codeforces redirected ${path} to ${page.location} — the session cookies are not signed in; re-send them with /renew`,
        };
      }
      attempts.push(`${path}: redirected to ${page.location ?? '?'}`);
      continue;
    }
    const form = parseSubmitPage(page.body, pageUrl);
    if (!form.csrf) {
      attempts.push(`${path}: no csrf_token (HTTP ${page.status})`);
      continue;
    }
    if (!form.hasSubmitForm) {
      attempts.push(`${path}: no submit form found`);
      continue;
    }
    if (!form.signedInHandle) {
      return { ok: false, kind: 'signed-out', error: 'Codeforces served the submit page anonymously — re-send the session cookies with /renew' };
    }
    const handle = form.signedInHandle;
    if (expectedHandle && handle.toLowerCase() !== expectedHandle.toLowerCase()) {
      logger.warn({ expectedHandle, handle }, 'Codeforces cookies belong to a different handle than stored');
    }
    if (form.problemIndexes.length && !form.problemIndexes.some((p) => p.toUpperCase() === entry.problemIndex!.toUpperCase())) {
      return { ok: false, kind: 'rejected', error: `contest ${entry.contestId} has no problem ${entry.problemIndex} (has ${form.problemIndexes.join(', ')})` };
    }
    const programTypeId = pickLanguage(form.languages, entry.language);
    if (!programTypeId) {
      return { ok: false, kind: 'rejected', error: `no ${entry.language === 'python' ? 'Python' : 'C++'} compiler offered on ${path}` };
    }

    const list = () =>
      entry.gym ? fetchContestStatus(entry.contestId!, handle, 30) : fetchUserStatus(handle, 30);
    const before = new Set((await list().catch(() => [] as CodeforcesSubmission[])).map((x) => x.id));
    const startedAt = Math.floor(now() / 1000);

    const jar = client.jar;
    const seed = jar?.get('39ce7') ?? state.cookies.find((c) => c.name === '39ce7')?.value ?? '';
    const bodyArgs: Record<string, string> = {
      ...form.hidden,
      csrf_token: form.csrf,
      // What the page itself rendered wins (that is what the browser submits);
      // the cookie is the fallback and a fresh id the last resort.
      ftaa: form.hidden['ftaa']?.trim() || jar?.get('_ftaa') || randomFtaa(),
      bfaa: form.hidden['bfaa']?.trim() || jar?.get('_bfaa') || randomHex(32),
      action: 'submitSolutionFormSubmitted',
      programTypeId,
      source: code,
      tabSize: '4',
      sourceFile: '',
      _tta: String(computeTta(seed)),
    };
    if (form.expectsProblemCode) {
      bodyArgs.submittedProblemCode = `${entry.contestId}${entry.problemIndex}`;
    } else {
      bodyArgs.submittedProblemIndex = entry.problemIndex;
    }
    const body = new URLSearchParams(bodyArgs);
    // Post to the form's own action, so Codeforces' per-page parameters survive.
    // A query-only action is relative to the page it sits on, and Codeforces
    // answers a submit form sent to the site root with 302 → "/", so a target
    // that collapsed to "/" is sent to the page itself instead.
    const target = new URL(form.action || pageUrl);
    if (target.pathname === '/' && new URL(pageUrl).pathname !== '/') {
      target.pathname = new URL(pageUrl).pathname;
    }
    const post = await client.post(target.toString(), body, pageUrl);
    logger.info(
      {
        path,
        pageUrl,
        action: form.actionRaw,
        target: target.toString(),
        hidden: Object.keys(form.hidden),
        status: post.status,
        location: post.location,
      },
      'Codeforces submission posted',
    );

    if (post.status === 403 || CHALLENGE_RE.test(post.body)) {
      return { ok: false, kind: 'blocked', error: `Cloudflare challenged the submit POST (HTTP ${post.status})` };
    }
    const formError = post.status === 200 ? extractFormError(post.body) : null;
    if (formError) return { ok: false, kind: 'rejected', error: `Codeforces refused the submission: ${formError}` };
    const redirectedTo = post.location ? safePath(post.location) : null;
    if (post.status >= 300 && post.status < 400 && (redirectedTo === '/' || redirectedTo === null)) {
      // Boxed in by the edge, not by this form: a POST to the site root and a
      // POST to a path that does not exist both answer 302 → "/" the same way,
      // so the next endpoint would only repeat it. The caller has to submit from
      // a real browser, which passes the challenge this client never passed.
      attempts.push(`${path}: POST ${post.status} → ${post.location}`);
      return {
        ok: false,
        kind: 'blocked',
        error: `Cloudflare redirected the submit POST to ${post.location} (HTTP ${post.status}) — every POST to codeforces.com is bounced for a client that has not passed its challenge, so the browser transport has to submit this one`,
        handle,
      } as HttpSubmitResult & { handle: string };
    }
    if (post.status >= 400) {
      return { ok: false, kind: 'error', error: `submit POST to ${target} returned HTTP ${post.status}` };
    }

    const deadline = now() + VERDICT_WINDOW_MS;
    // Bounded by iterations as well as by the clock, so a stalled clock can never spin.
    const maxPolls = Math.ceil(VERDICT_WINDOW_MS / POLL_INTERVAL_MS) + 2;
    let latest: CodeforcesSubmission | undefined;
    for (let poll = 0; poll < maxPolls && now() < deadline; poll++) {
      await wait(POLL_INTERVAL_MS);
      const found = (await list().catch(() => [] as CodeforcesSubmission[]))
        .filter((x) => !before.has(x.id) && x.creationTimeSeconds >= startedAt - 30)
        .filter((x) => (x.problem.contestId ?? x.contestId) === entry.contestId && x.problem.index === entry.problemIndex)
        .sort((a, b) => b.id - a.id)[0];
      if (found) {
        latest = found;
        if (!PENDING.has(found.verdict)) break;
      }
    }
    if (!latest) {
      return {
        ok: false,
        kind: 'judge-timeout',
        error: `posted via ${path} (HTTP ${post.status} → ${post.location ?? '?'}) but no ${entry.contestId}/${entry.problemIndex} submission appeared in the API`,
        handle,
      } as HttpSubmitResult & { handle: string };
    }
    const verdict = latest.verdict ?? 'TESTING';
    if (verdict === 'OK') return { ok: true, submissionId: String(latest.id), verdict, handle };
    return {
      ok: false,
      kind: PENDING.has(latest.verdict) ? 'judge-timeout' : 'rejected',
      error: PENDING.has(latest.verdict) ? `still ${verdict} after ${VERDICT_WINDOW_MS / 1000}s` : `Codeforces verdict: ${verdict}`,
      submissionId: String(latest.id),
      verdict,
      handle,
    };
  }

  return {
    ok: false,
    kind: 'rejected',
    error: `Codeforces refused the submission on every endpoint — ${attempts.join(' | ')}`,
  };
}

function safePath(location: string): string | null {
  try {
    return new URL(location, BASE).pathname;
  } catch {
    return null;
  }
}
