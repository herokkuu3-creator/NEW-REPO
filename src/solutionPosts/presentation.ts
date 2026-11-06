import { prisma } from '../database/prisma';
import { ArticlePresentation, presentationSchema, presentationVariant } from './presentationStyles';
export * from './presentationStyles';

/** A durable assignment avoids identical neighboring accounts and survives retries. */
export async function reserveArticlePresentation(accountId: string, _slug: string): Promise<ArticlePresentation> {
  // Account identity is global: changing problem or restarting cannot reset
  // every batch back to the same first template. Legacy assignments stay intact.
  const key = 'solution-presentation:accounts:v2';
  for (let attempt = 0; attempt < 64; attempt++) {
    const row = await prisma.systemState.findUnique({ where: { key } });
    const state: { next: number; accounts: Record<string, ArticlePresentation> } = row ? JSON.parse(row.value) : { next: 0, accounts: {} };
    if (state.accounts[accountId]) return presentationSchema.parse(state.accounts[accountId]);
    const presentation = presentationVariant(state.next);
    const value = JSON.stringify({ next: state.next + 1, accounts: { ...state.accounts, [accountId]: presentation } });
    if (row) {
      if ((await prisma.systemState.updateMany({ where: { key, value: row.value }, data: { value } })).count) return presentation;
    } else {
      try { await prisma.systemState.create({ data: { key, value } }); return presentation; }
      catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
    }
  }
  throw new Error('PRESENTATION_ASSIGNMENT_BUSY');
}
