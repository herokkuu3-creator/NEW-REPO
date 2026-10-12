import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AttemptCancelledError, attemptSleep } from '../src/codeforces/attemptContext';

const state = vi.hoisted(() => ({ entered: 0, posting: false, waitAtPost: false, launches: 0, closes: 0, posts: 0 }));
vi.mock('../src/browser/stealth', () => ({ applyStealthScripts: async () => {}, interactWithTurnstileCheckbox: async () => false }));
vi.mock('playwright', () => {
  const launch = async () => {
    state.launches++;
    const fields = [
      { name: 'source', tag: 'textarea' }, { name: 'csrf_token', tag: 'input' },
      { name: 'programTypeId', tag: 'select' }, { name: 'submittedProblemIndex', tag: 'input' },
    ];
    const page = {
      goto: async () => ({ status: () => 200 }), url: () => 'https://codeforces.com/contest/1/submit',
      title: async () => 'Owned local form fixture', evaluate: async (_fn: unknown, args?: unknown) => args ? true : fields,
      locator: (selector: string) => {
        const locator = {
          first: () => locator, count: async () => selector.includes('contestId') ? 0 : 1,
          innerText: async () => 'Owned local form fixture', waitFor: async () => {},
          fill: async () => {}, inputValue: async () => 'local-csrf',
          evaluateAll: async () => [{ value: '89', text: 'GNU G++23' }],
        };
        return locator;
      },
    };
    const context = { pages: () => [page], on: () => {}, route: async () => {}, close: async () => {} };
    return { newContext: async () => context, close: async () => { state.closes++; } };
  };
  return { chromium: { launch }, firefox: { launch } };
});
vi.mock('../src/codeforces/browserForm', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  fillSource: async () => {},
  ensureFormTurnstile: async () => {
    state.entered++;
    if (!state.waitAtPost) await attemptSleep(60_000);
    return { turnstile: false, interactive: false };
  },
  clickSubmitForm: async () => {
    state.posts++; state.posting = true;
    await attemptSleep(60_000);
    return { clicked: true, status: 200 };
  },
}));

let submit: typeof import('../src/codeforces/submitterService').submit;
let server: Server;
let origin: string;
const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' };
const request = () => ({ requestId: 'owned-fixture', attemptDeadline: Date.now() + 60_120,
  code: 'local fixture', entry: { contestId: 1, problemIndex: 'A' }, state: { cookies: [] } });
beforeAll(async () => {
  vi.stubEnv('CODEFORCES_RUNNER_MODE', 'render');
  vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'fixture-token');
  vi.stubEnv('CODEFORCES_BROWSER_MIN_FREE_MB', '0');
  vi.stubEnv('CI', 'false'); vi.stubEnv('GITHUB_ACTIONS', 'false'); vi.stubEnv('STRICT_PROXY', 'false');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('CODEFORCES_PROXY', '');
  ({ submit, server } = await import('../src/codeforces/submitterService'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { Object.assign(state, { entered: 0, posting: false, waitAtPost: false, launches: 0, closes: 0, posts: 0 }); });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });

it('deadline closes the browser and reports no POST while verification is pending', async () => {
  await expect(submit(request())).rejects.toMatchObject({ kind: 'blocked', clicked: false });
  expect(state.entered).toBe(1); expect(state.closes).toBeGreaterThan(0); expect(state.posts).toBe(0);
});
it('pre-expired attempts never launch a browser', async () => {
  await expect(submit({ ...request(), attemptDeadline: Date.now() })).rejects.toMatchObject({ kind: 'blocked', clicked: false });
  expect(state.launches).toBe(0);
});
it('cancellation after a POST starts preserves an uncertain outcome instead of claiming no submission', async () => {
  state.waitAtPost = true;
  await expect(submit(request())).rejects.toMatchObject({ kind: 'submission-error', clicked: true, message: expect.stringContaining('acceptance is uncertain') });
  expect(state.posts).toBe(1);
});
it('a caller disconnect cancels verification and releases HTTP busy state', async () => {
  const controller = new AbortController();
  const response = fetch(`${origin}/submit`, { method: 'POST', headers, body: JSON.stringify({ ...request(), attemptDeadline: Date.now() + 120_000 }), signal: controller.signal });
  const rejection = expect(response).rejects.toBeDefined();
  await vi.waitFor(() => expect(state.entered).toBe(1));
  controller.abort(new AttemptCancelledError('disconnect'));
  await rejection;
  await vi.waitFor(async () => expect((await (await fetch(`${origin}/health`)).json()).busy).toBe(false));
  expect(state.posts).toBe(0); expect(state.closes).toBeGreaterThan(0);
});
it('two simultaneous body uploads reserve only one browser', async () => {
  let seen = 0;
  let ready!: () => void;
  const accepted = new Promise<void>(resolve => { ready = resolve; });
  const observe = (incoming: http.IncomingMessage) => { if (incoming.url === '/submit' && ++seen === 2) ready(); };
  server.on('request', observe);
  const start = () => {
    let client!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      client = http.request(`${origin}/submit`, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      client.on('error', reject); client.flushHeaders();
    });
    return { client, response };
  };
  const first = start(), second = start();
  try {
    await accepted;
    first.client.end(JSON.stringify(request())); second.client.end(JSON.stringify(request()));
    expect((await Promise.all([first.response, second.response])).sort()).toEqual([200, 409]);
    expect(state.launches).toBe(1); expect(state.posts).toBe(0);
  } finally { server.removeListener('request', observe); first.client.destroy(); second.client.destroy(); }
});
