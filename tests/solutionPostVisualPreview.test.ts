import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ account: { status: 'ACTIVE', username: 'alice' }, reserve: vi.fn(), store: vi.fn(), verify: vi.fn() }));
vi.mock('../src/database/prisma', () => ({ prisma: { account: { findUniqueOrThrow: async () => h.account } } }));
vi.mock('../src/solutionPosts/presentation', () => ({ reserveArticlePresentation: h.reserve }));
vi.mock('../src/solutionPosts/visualStore', () => ({ storeVisualAssets: h.store, verifyHostedVisualAssets: h.verify }));
import { createAccountVisualPreview } from '../src/solutionPosts/visualPreview';
import { presentationVariant } from '../src/solutionPosts/presentationStyles';
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('RENDER_INSTANCE_ID', 'render'); vi.stubEnv('RENDER_GIT_COMMIT', 'preview-revision');
  h.account.status = 'ACTIVE'; h.reserve.mockResolvedValue(presentationVariant(3));
  h.store.mockResolvedValue([{ id: 'visual-1' }, { id: 'visual-2' }]); h.verify.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
it('uses the real account assignment and normal asset store on Render', async () => {
  const result = await createAccountVisualPreview('a');
  expect(result).toMatchObject({ executionHost: 'render', revision: 'preview-revision', username: 'alice', presentation: { visualVersion: 4, scenes: ['stage', 'split'] } });
  expect(h.reserve).toHaveBeenCalledWith('a', 'visual-preview');
  const plans = h.store.mock.calls[0]![0];
  expect(plans.map((plan: any) => plan.layout)).toEqual(presentationVariant(3).diagrams);
  expect(plans.map((plan: any) => plan.scene)).toEqual(['stage', 'split']);
  expect(plans[0].frames).toHaveLength(3);
  expect(plans[1].frames).toHaveLength(4);
  expect(plans[0].frames).not.toEqual(plans[1].frames);
  expect(h.verify).toHaveBeenCalledWith(result.assets, expect.any(String));
});
it('rejects local execution and disabled accounts before creating assets', async () => {
  vi.stubEnv('RENDER_INSTANCE_ID', ''); await expect(createAccountVisualPreview('a')).rejects.toThrow('RENDER_SERVER_REQUIRED');
  vi.stubEnv('RENDER_INSTANCE_ID', 'render'); h.account.status = 'DISABLED';
  await expect(createAccountVisualPreview('a')).rejects.toThrow('ACCOUNT_UNAVAILABLE');
  expect(h.store).not.toHaveBeenCalled();
});
it('does not report success for GIFs the public server cannot serve', async () => {
  h.verify.mockResolvedValue(false);
  await expect(createAccountVisualPreview('a')).rejects.toThrow('PUBLIC_VISUAL_PREVIEW_FAILED');
});
