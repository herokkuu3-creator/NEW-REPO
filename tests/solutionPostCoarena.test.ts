import { afterEach, expect, it, vi } from 'vitest';
import { AIModelRouter } from '../src/solutionPosts/router';
import { CoarenaRouter, COARENA_WRITER } from '../src/solutionPosts/coarena';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const request = [{ role: 'user' as const, content: 'Write an article.' }];
const validate = (output: string) => output.trim();

it('skips primary inference when the free allowance is spent and sticks to Discovery for that job', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 5, left_usd: 0, resets_at: 1000, requests_left: null,
  } } }));
  vi.stubGlobal('fetch', fetcher);
  const infer = vi.spyOn(AIModelRouter.prototype, 'generate');
  const fallback = vi.fn(async () => ({ value: 'fallback', model: 'discovery', attempts: [] }));
  const createFallback = vi.fn(async () => ({ generate: fallback }) as unknown as AIModelRouter);
  const router = new CoarenaRouter('coa_test', createFallback);
  const result = await router.generate(request, validate);
  expect(result.attempts).toMatchObject([{ model: COARENA_WRITER, provider: 'coarena', outcome: 'COARENA_DAILY_LIMIT' }]);
  expect((await router.generate(request, validate)).value).toBe('fallback');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(createFallback).toHaveBeenCalledOnce();
  expect(infer).not.toHaveBeenCalled();
});

it('uses the primary when within the free allowance without initializing Discovery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 0, left_usd: 5, resets_at: 1000, requests_left: null,
  } } })));
  const infer = vi.spyOn(AIModelRouter.prototype, 'generate').mockResolvedValue({ value: 'primary', model: COARENA_WRITER, attempts: [] });
  const fallback = vi.fn(async () => { throw new Error('unexpected fallback'); });
  const router = new CoarenaRouter('coa_test', fallback);
  expect((await router.generate(request, validate, 1024, true, 'technical review implementation')).value).toBe('primary');
  expect(infer).toHaveBeenCalledWith([...request, { role: 'user', content: 'Return the result as a JSON object.' }],
    validate, 2400, true, 'technical review implementation');
  expect(fallback).not.toHaveBeenCalled();
});
