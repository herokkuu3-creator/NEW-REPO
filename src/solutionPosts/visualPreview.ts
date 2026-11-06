import { config } from '../config';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { reserveArticlePresentation } from './presentation';
import { storeVisualAssets, verifyHostedVisualAssets } from './visualStore';
import { visualPreviewPlans } from './visualSamples';

export async function createAccountVisualPreview(accountId: string) {
  if (!process.env.RENDER_INSTANCE_ID) throw Error('RENDER_SERVER_REQUIRED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  if (account.status !== 'ACTIVE') throw Error('ACCOUNT_UNAVAILABLE');
  const presentation = await reserveArticlePresentation(accountId, 'visual-preview');
  const assets = await storeVisualAssets(visualPreviewPlans(presentation), config.api.publicUrl);
  if (!await verifyHostedVisualAssets(assets, config.api.publicUrl)) throw Error('PUBLIC_VISUAL_PREVIEW_FAILED');
  logger.info({ accountId, presentation, executionHost: 'render', revision: process.env.RENDER_GIT_COMMIT }, 'account GIF presentation preview verified');
  return { accountId, username: account.username, executionHost: 'render', revision: process.env.RENDER_GIT_COMMIT ?? null,
    presentation, assets, sample: 'Identical demonstration values for comparing visual styles; no article is published.' };
}
