import { z } from 'zod';
import { prisma } from '../database/prisma';

export const articleLayouts = ['notebook', 'questions', 'example-first', 'recipe', 'interview', 'field-guide'] as const;
export const diagramLayouts = ['strip', 'ledger', 'focus'] as const;
export const presentationSchema = z.object({
  layout: z.enum(articleLayouts), diagrams: z.tuple([z.enum(diagramLayouts), z.enum(diagramLayouts)]),
  themes: z.tuple([z.enum(['aurora', 'sunset', 'ocean', 'violet']), z.enum(['aurora', 'sunset', 'ocean', 'violet'])]),
  codePlacement: z.enum(['end', 'after-approach']).default('end'),
  costStyle: z.enum(['standard', 'bullets', 'compact']).default('standard'),
});
export type ArticlePresentation = z.infer<typeof presentationSchema>;
const themes = ['aurora', 'sunset', 'ocean', 'violet'] as const;
export function presentationVariant(index: number): ArticlePresentation {
  return { layout: articleLayouts[index % articleLayouts.length]!,
    diagrams: [diagramLayouts[index % 3]!, diagramLayouts[(index + 1) % 3]!],
    themes: [themes[index % 4]!, themes[(index + 2) % 4]!],
    codePlacement: Math.floor(index / 6) % 2 ? 'after-approach' : 'end',
    costStyle: (['standard', 'bullets', 'compact'] as const)[Math.floor(index / 12) % 3]! };
}

/** A durable assignment avoids identical neighboring accounts and survives retries. */
export async function reserveArticlePresentation(accountId: string, slug: string): Promise<ArticlePresentation> {
  const key = `solution-presentation:${slug}`;
  for (let attempt = 0; attempt < 8; attempt++) {
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

export const layoutGuidance: Record<ArticlePresentation['layout'], string> = {
  notebook: 'A compact notebook: observation, three actions, visual trace, and a small invariant callout.',
  questions: 'Answer short reader questions: why this idea, what to do, what stays true, and a tiny worked example.',
  'example-first': 'Lead with one tiny concrete worked example, then explain the idea it reveals and the recipe.',
  recipe: 'A practical recipe: give the key ingredient, concise steps, a test drive and the reason it works.',
  interview: 'An interview brief: state the insight, explain the decision rule, demonstrate it and finish with the invariant.',
  'field-guide': 'A visual field guide: open with the pattern to recognize, then the invariant, trace and implementation steps.',
};
