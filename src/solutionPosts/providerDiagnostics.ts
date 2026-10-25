import { config } from '../config';
import { setSystemState } from '../database/models';
import { logger } from '../logger';
import { testSolutionApiKey } from './keyPool';

export const PROVIDER_CHECK_STATE_KEY = 'solution-post-provider:last-check';

/** A small real inference check on the deployed host; it never mutates quota pointers or posts. */
export async function verifySolutionProviderOnBoot(): Promise<void> {
  if (process.env.SOLUTION_POST_VERIFY_ON_BOOT === 'false') return;
  const models = config.solutionPosts.models.slice(0, 3);
  const results = [];
  for (const model of models) {
    const result = await testSolutionApiKey(undefined, model);
    results.push(result);
    logger.info({ provider: new URL(config.solutionPosts.baseUrl).hostname, diagnostic: result }, 'solution provider server startup probe');
  }
  await setSystemState(PROVIDER_CHECK_STATE_KEY, JSON.stringify({ checkedAt: new Date().toISOString(), results }));
}
