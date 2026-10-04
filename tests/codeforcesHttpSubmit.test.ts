import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchUserStatus: vi.fn(), fetchContestStatus: vi.fn() }));
vi.mock('../src/codeforces/api', () => api);

import {
  computeTta,
  cookieHeader,
  extractFormError,
  HttpClient,
  parseSubmitPage,
  pickLanguage,
  submitViaHttp,
} from '../src/codeforces/httpSubmit';
import { SourceIndexEntry } from '../src/codeforces/sourceRepo';

const CSRF = '04791954deebb2e57daefb4d2516ac64';
const HEADER_IN = `<div class="lang-chooser"><div><a href="?locale=en">en</a></div>
  <div><a href="/profile/me_superman">me_superman</a> | <a href="/9c1d2e/logout">Logout</a></div></div>
  <div class="roundbox menu-box">`;
const HEADER_OUT = `<div class="lang-chooser"><div><a href="/enter?back=%2F">Enter</a> | <a href="/register">Register</a></div></div>
  <div class="roundbox menu-box"><a href="/profile/tourist">tourist</a>`;
const FORM = `<form class="submit-form" method="post" action="/contest/1/submit?csrf_token=${CSRF}">
  <input type='hidden' name='csrf_token' value='${CSRF}'/>
  <select name="submittedProblemIndex"><option value="">Choose problem</option><option value="A">A - Theatre Square</option><option value="B">B - Spreadsheet</option></select>
  <select name="programTypeId"><option value="54">GNU G++17 7.3.0</option><option value="89">GNU G++20 13.2 (64 bit, winlibs)</option>
  <option value="91" selected="selected">GNU G++23 14.2 (64 bit, msys2)</option><option value="70">PyPy 3.10 (7.3.15, 64bit)</option><option value="31">Python 3.13.2</option></select>
  <textarea name="source"></textarea></form>`;
const SUBMIT_PAGE = `<html><head><title>Submit</title></head><body>${HEADER_IN}${FORM}</body></html>`;

const entry = { key: '1A.cpp', contestId: 1, problemIndex: 'A', problemName: 'Theatre Square', language: 'cpp', gym: false } as SourceIndexEntry;
const state = {
  cookies: [
    { name: 'JSESSIONID', value: 'J1', domain: 'codeforces.com', path: '/', expires: -1 },
    { name: '39ce7', value: 'CFEn0u5X', domain: '.codeforces.com', path: '/', expires: -1 },
    { name: 'cf_clearance', value: 'bound-to-other-browser', domain: '.codeforces.com', path: '/', expires: -1 },
    { name: 'X', value: 'other-site', domain: 'leetcode.com', path: '/', expires: -1 },
  ],
  origins: [],
} as never;

type Reply = { status: number; location?: string | null; body?: string };
type Handler = Reply | ((key: string) => Reply);
function fakeClient(get: Handler, post: Handler) {
  const calls: Array<{ method: string; path: string; form?: URLSearchParams; referer?: string }> = [];
  const pick = (h: Handler, key: string): Reply => (typeof h === 'function' ? h(key) : h);
  const client: HttpClient = {
    jar: new Map([['39ce7', 'CFEn0u5X']]),
    get: async (path) => { calls.push({ method: 'GET', path }); return { location: null, body: '', setCookies: [], ...pick(get, path) } as never; },
    post: async (path, form, referer) => { calls.push({ method: 'POST', path, form, referer }); return { location: null, body: '', setCookies: [], ...pick(post, path) } as never; },
  };
  return { client, calls };
}
const noSleep = async () => undefined;
const sub = (id: number, verdict: string | undefined, index = 'A', t = 2_000_000_000) =>
  ({ id, problem: { contestId: 1, index }, contestId: 1, verdict, creationTimeSeconds: t });

beforeEach(() => { api.fetchUserStatus.mockReset(); api.fetchContestStatus.mockReset(); });

describe('request building', () => {
  it('computes _tta exactly like Codeforces.tta() (value checked against codeforces.js)', () => {
    expect(computeTta('CFEn0u5X')).toBe(331);
    expect(computeTta('')).toBe(0);
  });

  it('sends only codeforces.com cookies and drops the browser-bound Cloudflare clearance', () => {
    const header = cookieHeader(state);
    expect(header).toContain('JSESSIONID=J1');
    expect(header).toContain('39ce7=CFEn0u5X');
    expect(header).not.toContain('cf_clearance');
    expect(header).not.toContain('other-site');
  });

  it('parses csrf, the signed-in handle, problems and compilers from the submit page', () => {
    const page = parseSubmitPage(SUBMIT_PAGE);
    expect(page.csrf).toBe(CSRF);
    expect(page.signedInHandle).toBe('me_superman');
    expect(page.problemIndexes).toEqual(['A', 'B']);
    expect(pickLanguage(page.languages, 'cpp')).toBe('91');
    expect(pickLanguage(page.languages, 'python')).toBe('70');
  });

  it('does not mistake a sidebar profile link for a login when signed out', () => {
    expect(parseSubmitPage(`<html>${HEADER_OUT}</html>`).signedInHandle).toBeNull();
  });

  it('reads the error Codeforces prints under the form', () => {
    expect(extractFormError('<span class="error for__source">You have submitted exactly the same code before</span>'))
      .toBe('You have submitted exactly the same code before');
    expect(extractFormError('<span class="notice">ok</span>')).toBeNull();
  });
});

describe('submitViaHttp', () => {
  it('posts the exact payload from the DevTools capture and returns the OK verdict', async () => {
    api.fetchUserStatus.mockResolvedValueOnce([sub(10, 'OK', 'C', 1)]).mockResolvedValueOnce([sub(11, 'TESTING')]).mockResolvedValueOnce([sub(11, 'OK')]);
    const { client, calls } = fakeClient({ status: 200, body: SUBMIT_PAGE }, { status: 302, location: 'https://codeforces.com/contest/1/my' });
    const result = await submitViaHttp(state, 'me_superman', entry, '#include <bits/stdc++.h>\nint main(){}', { client, sleep: noSleep, now: () => 2_000_000_000_000 });

    expect(result).toMatchObject({ ok: true, submissionId: '11', verdict: 'OK', handle: 'me_superman' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/contest/1/submit' });
    const post = calls[1]!;
    expect(post.path).toBe(`https://codeforces.com/contest/1/submit?csrf_token=${CSRF}`);
    expect(post.referer).toBe('https://codeforces.com/contest/1/submit');
    const f = post.form!;
    expect(f.get('csrf_token')).toBe(CSRF);
    expect(f.get('action')).toBe('submitSolutionFormSubmitted');
    expect(f.get('submittedProblemIndex')).toBe('A');
    expect(f.get('programTypeId')).toBe('91');
    expect(f.get('source')).toContain('int main');
    expect(f.get('ftaa')).toMatch(/^[a-z0-9]{18}$/);
    expect(f.get('bfaa')).toMatch(/^[0-9a-f]{32}$/);
    expect(f.get('_tta')).toBe('331');
  });

  it('reports a wrong answer with its submission id', async () => {
    api.fetchUserStatus.mockResolvedValueOnce([]).mockResolvedValue([sub(12, 'WRONG_ANSWER')]);
    const { client } = fakeClient({ status: 200, body: SUBMIT_PAGE }, { status: 302, location: '/contest/1/my' });
    const result = await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });
    expect(result).toMatchObject({ ok: false, kind: 'rejected', verdict: 'WRONG_ANSWER', submissionId: '12' });
  });

  it('surfaces the reason when Codeforces re-renders the form with an error', async () => {
    api.fetchUserStatus.mockResolvedValue([]);
    const { client } = fakeClient(
      { status: 200, body: SUBMIT_PAGE },
      { status: 200, body: `${SUBMIT_PAGE}<span class="error for__source">You have submitted exactly the same code before</span>` },
    );
    const result = await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, kind: 'rejected' });
    expect(result.ok || result.error).toContain('same code before');
  });

  it('flags expired cookies instead of posting anonymously', async () => {
    const { client, calls } = fakeClient({ status: 302, location: 'https://codeforces.com/enter' }, { status: 500 });
    const result = await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, kind: 'signed-out' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reports a Cloudflare challenge as blocked', async () => {
    const { client } = fakeClient({ status: 403, body: '<title>Just a moment...</title>' }, { status: 500 });
    expect(await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep })).toMatchObject({ ok: false, kind: 'blocked' });
  });

  it('refuses a problem letter the contest does not have', async () => {
    const { client, calls } = fakeClient({ status: 200, body: SUBMIT_PAGE }, { status: 302 });
    const result = await submitViaHttp(state, 'me_superman', { ...entry, problemIndex: 'Z' } as SourceIndexEntry, 'x', { client, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, kind: 'rejected' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('uses the gym submit path and contest.status for gym problems', async () => {
    api.fetchContestStatus.mockResolvedValueOnce([]).mockResolvedValue([{ ...sub(13, 'OK', '1'), problem: { contestId: 101021, index: '1' }, contestId: 101021 }]);
    const gymPage = SUBMIT_PAGE.replace('<option value="A">A - Theatre Square</option>', '<option value="1">1 - Guess</option>');
    const { client, calls } = fakeClient({ status: 200, body: gymPage }, { status: 302, location: '/gym/101021/my' });
    const result = await submitViaHttp(state, 'me_superman', { ...entry, contestId: 101021, problemIndex: '1', gym: true } as SourceIndexEntry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });
    expect(calls[0]!.path).toBe('/gym/101021/submit');
    expect(result).toMatchObject({ ok: true, submissionId: '13' });
  });
});

describe('the codeforces submit form is replayed exactly', () => {
  it('posts to the form action verbatim, keeping Codeforces per-page parameters', async () => {
    api.fetchUserStatus.mockResolvedValue([]);
    const page = SUBMIT_PAGE.replace(
      `action="/contest/1/submit?csrf_token=${CSRF}"`,
      `action="/contest/1/submit?adcd1e=caf4ffwp26nzrb&csrf_token=${CSRF}"`,
    );
    const { client, calls } = fakeClient({ status: 200, body: page }, { status: 302, location: 'https://codeforces.com/contest/1/my' });
    await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });
    expect(calls[1]!.path).toBe(`https://codeforces.com/contest/1/submit?adcd1e=caf4ffwp26nzrb&csrf_token=${CSRF}`);
  });

  it('carries over every hidden input on the form', async () => {
    api.fetchUserStatus.mockResolvedValue([]);
    const page = SUBMIT_PAGE.replace(
      `<input type='hidden' name='csrf_token' value='${CSRF}'/>`,
      `<input type='hidden' name='csrf_token' value='${CSRF}'/><input type="hidden" name="_tta" value="331"/><input type="hidden" name="adcd1e" value="tok"/>`,
    );
    const { client, calls } = fakeClient({ status: 200, body: page }, { status: 302, location: '/contest/1/my' });
    await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });
    const f = calls[1]!.form!;
    expect(f.get('adcd1e')).toBe('tok');
    expect(f.get('csrf_token')).toBe(CSRF);
  });

  it('stops at the first endpoint and reports the edge block when the POST is bounced to "/" (the reported failure)', async () => {
    api.fetchUserStatus.mockResolvedValue([]);
    const { client, calls } = fakeClient({ status: 200, body: SUBMIT_PAGE }, { status: 302, location: 'https://codeforces.com/' });
    const result = await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep });

    // Measured against the live site: a POST to the site root and a POST to a
    // path that does not exist both answer 302 → "/", so another endpoint would
    // only repeat it. The caller switches to the browser transport instead.
    expect(result).toMatchObject({ ok: false, kind: 'blocked' });
    expect(result.ok || result.error).toContain('Cloudflare');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});

describe('an action that lost its path is still posted to the page', () => {
  it('resolves a query-only action against the page url it sits on', () => {
    const page = parseSubmitPage(
      SUBMIT_PAGE.replace(`action="/contest/1/submit?csrf_token=${CSRF}"`, `action="?csrf_token=${CSRF}"`),
      'https://codeforces.com/contest/1/submit',
    );
    expect(page.actionRaw).toBe(`?csrf_token=${CSRF}`);
    expect(page.action).toBe(`https://codeforces.com/contest/1/submit?csrf_token=${CSRF}`);
  });

  it('keeps the submit path when the form renders a query-only action (the reported failure)', async () => {
    api.fetchUserStatus.mockResolvedValueOnce([]).mockResolvedValue([sub(31, 'OK')]);
    const page = SUBMIT_PAGE.replace(`action="/contest/1/submit?csrf_token=${CSRF}"`, `action="?csrf_token=${CSRF}"`);
    const { client, calls } = fakeClient({ status: 200, body: page }, { status: 302, location: '/contest/1/my' });
    const result = await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });

    expect(calls[1]!.path).toBe(`https://codeforces.com/contest/1/submit?csrf_token=${CSRF}`);
    expect(result).toMatchObject({ ok: true, submissionId: '31' });
  });

  it('never posts the submit form to the site root', async () => {
    api.fetchUserStatus.mockResolvedValueOnce([]).mockResolvedValue([sub(32, 'OK')]);
    const page = SUBMIT_PAGE.replace(`action="/contest/1/submit?csrf_token=${CSRF}"`, `action="/?csrf_token=${CSRF}"`);
    const { client, calls } = fakeClient({ status: 200, body: page }, { status: 302, location: '/contest/1/my' });
    await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });

    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `https://codeforces.com/contest/1/submit?csrf_token=${CSRF}`,
    ]);
  });

  it('reuses the ftaa/bfaa the page rendered instead of inventing new ones', async () => {
    api.fetchUserStatus.mockResolvedValueOnce([]).mockResolvedValue([sub(33, 'OK')]);
    const page = SUBMIT_PAGE.replace(
      `<input type='hidden' name='csrf_token' value='${CSRF}'/>`,
      `<input type='hidden' name='csrf_token' value='${CSRF}'/>` +
        `<input type="hidden" name="ftaa" value="abc123def456ghi789"/>` +
        `<input type="hidden" name="bfaa" value="d41d8cd98f00b204e9800998ecf8427e"/>`,
    );
    const { client, calls } = fakeClient({ status: 200, body: page }, { status: 302, location: '/contest/1/my' });
    await submitViaHttp(state, 'me_superman', entry, 'x', { client, sleep: noSleep, now: () => 2_000_000_000_000 });

    const f = calls[1]!.form!;
    expect(f.get('ftaa')).toBe('abc123def456ghi789');
    expect(f.get('bfaa')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});
