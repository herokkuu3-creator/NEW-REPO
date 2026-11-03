import { config } from '../config';
import { setSystemState } from '../database/models';
import { logger } from '../logger';
import { testSolutionApiKey } from './keyPool';
import { createHash } from 'node:crypto';
import { FIRECRAWL_START_INTERVAL_MS, FIRECRAWL_QUEUE_WAIT_MS } from './firecrawlRateGate';

export const PROVIDER_CHECK_STATE_KEY = 'solution-post-provider:last-check';

/** A small real inference check on the deployed host; it never mutates quota pointers or posts. */
export async function verifySolutionProviderOnBoot(): Promise<void> {
  if (config.solutionPosts.aiProvider === 'firecrawl') {
    logger.info({ provider: 'firecrawl-agent', keyConfigured: Boolean(config.solutionPosts.firecrawlApiKey),
      maxCreditsPerJob: config.solutionPosts.agentMaxCredits, agentStartIntervalMs: FIRECRAWL_START_INTERVAL_MS,
      agentQueueWaitMs: FIRECRAWL_QUEUE_WAIT_MS }, 'solution article credential configuration');
    if (config.solutionPosts.firecrawlApiKey && process.env.SOLUTION_POST_VERIFY_ON_BOOT !== 'false') {
      const response = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
        headers: { Authorization: `Bearer ${config.solutionPosts.firecrawlApiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      let remainingCredits: number | null = null;
      if (response.ok) {
        const result: any = await response.json();
        if (typeof result?.data?.remainingCredits === 'number') remainingCredits = result.data.remainingCredits;
      }
      logger.info({ provider: 'firecrawl-agent', httpStatus: response.status, remainingCredits,
        keyFingerprint: createHash('sha256').update(config.solutionPosts.firecrawlApiKey).digest('hex').slice(0, 12) },
        'Firecrawl server credit check (no Agent job started)');
    }
    return; // Avoid consuming agent credits on every restart.
  }
  logger.info({ provider: new URL(config.solutionPosts.baseUrl).hostname,
    keySource: config.solutionPosts.keySource, environment: config.solutionPosts.keyEnvironment,
    configuredKeyCount: config.solutionPosts.apiKeys?.length ?? 0, inputError: config.solutionPosts.keyError },
  'solution article credential configuration');
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
