import { describe, expect, it, vi } from 'vitest';
import { ActionBroker, dispatchAction } from '../src/codeforces/actionBroker';

describe('Codeforces Actions handoff', () => {
  it('dispatches an opaque id, claims credentials once, and returns the result', async () => {
    const dispatch = vi.fn(async (_id: string) => undefined);
    const broker = new ActionBroker(dispatch);
    const payload = { code: 'int main() {}', state: { cookies: [{ name: 'session', value: 'secret' }] } };
    const id = await broker.enqueue(payload);
    expect(dispatch).toHaveBeenCalledWith(id);
    expect(dispatch.mock.calls[0]?.[0]).not.toContain('secret');
    expect(broker.busy).toBe(true);
    expect(broker.nextId).toBe(id);
    expect(broker.claim(id)).toEqual(payload);
    expect(broker.nextId).toBeNull();
    expect(broker.claim(id)).toBeNull();
    expect(broker.status(id)).toEqual({ pending: true });
    expect(broker.finish(id, { ok: true, clicked: true })).toBe(true);
    expect(broker.finish(id, { ok: true, clicked: true })).toBe(true);
    expect(broker.finish(id, { ok: false, clicked: false })).toBe(false);
    expect(broker.status(id)).toEqual({ pending: false, result: { ok: true, clicked: true } });
    expect(broker.busy).toBe(false);
  });

  it('releases a job if dispatch fails and expires abandoned jobs', async () => {
    let now = 0;
    const failed = new ActionBroker(async () => { throw new Error('dispatch failed'); }, () => now);
    await expect(failed.enqueue({ code: 'x' })).rejects.toThrow('dispatch failed');
    expect(failed.busy).toBe(false);
    const broker = new ActionBroker(async () => undefined, () => now);
    const id = await broker.enqueue({ code: 'x' });
    now += 25 * 60_000;
    expect(broker.claim(id)).toBeNull();
    expect(broker.status(id)).toBeNull();
    expect(broker.busy).toBe(false);
  });

  it('passes only the job id to the GitHub dispatch endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await dispatchAction('owner/repo', 'dispatch-secret', 'job-id');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/codeforces-submit.yml/dispatches');
      expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { job_id: 'job-id' } });
      expect(String(init.body)).not.toContain('dispatch-secret');
    } finally { vi.unstubAllGlobals(); }
  });

  it('fails immediately when the Render dispatch token is absent', async () => {
    await expect(dispatchAction('owner/repo', '', 'job-id')).rejects.toThrow('GITHUB_DISPATCH_TOKEN is missing');
  });
});
