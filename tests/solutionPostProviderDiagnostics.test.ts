import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ probe: vi.fn(async () => ({ ok: true })), save: vi.fn() }));
vi.mock('../src/config', () => ({ config: { solutionPosts: { baseUrl: 'https://api.bazaarlink.ai/v1',
  models: ['qwen/qwen3.7-flash:free'], apiKey: 'outdated_environment_key' } } }));
vi.mock('../src/database/models', () => ({ setSystemState: h.save }));
vi.mock('../src/solutionPosts/keyPool', () => ({ testSolutionApiKey: h.probe }));
vi.mock('../src/logger', () => ({ logger: { info: vi.fn() } }));
import { verifySolutionProviderOnBoot } from '../src/solutionPosts/providerDiagnostics';
afterEach(() => vi.unstubAllEnvs());
it('probes the configured free Qwen model using the active saved pool rather than an old bootstrap key', async () => {
  vi.stubEnv('SOLUTION_POST_VERIFY_ON_BOOT', 'true');
  await verifySolutionProviderOnBoot();
  expect(h.probe).toHaveBeenCalledWith(undefined, 'qwen/qwen3.7-flash:free');
  expect(h.save).toHaveBeenCalledWith('solution-post-provider:last-check', expect.stringContaining('"ok":true'));
});
