import { z } from 'zod';
import { accountDiagramLayouts, accountVisualThemes, diagramLayouts, visualMotions, visualThemes } from './visualStyles';

export const articleLayouts = ['notebook', 'questions', 'example-first', 'recipe', 'interview', 'field-guide'] as const;
export { diagramLayouts } from './visualStyles';
export const presentationSchema = z.object({
  layout: z.enum(articleLayouts), diagrams: z.tuple([z.enum(diagramLayouts), z.enum(diagramLayouts)]),
  themes: z.tuple([z.enum(visualThemes), z.enum(visualThemes)]),
  motions: z.tuple([z.enum(visualMotions), z.enum(visualMotions)]).optional(),
  visualVersion: z.literal(2).optional(),
  codePlacement: z.enum(['end', 'after-approach']).default('end'),
  costStyle: z.enum(['standard', 'bullets', 'compact']).default('standard'),
});
export type ArticlePresentation = z.infer<typeof presentationSchema>;
export function presentationVariant(index: number): ArticlePresentation {
  const batch = Math.floor(index / accountDiagramLayouts.length);
  return { layout: articleLayouts[index % articleLayouts.length]!,
    diagrams: [accountDiagramLayouts[index % accountDiagramLayouts.length]!, accountDiagramLayouts[(index + 1 + (6 + batch) % 14) % accountDiagramLayouts.length]!],
    themes: [accountVisualThemes[(index + batch * 4) % accountVisualThemes.length]!, accountVisualThemes[(index + 11 + batch * 4) % accountVisualThemes.length]!],
    motions: [visualMotions[index % visualMotions.length]!, visualMotions[(index + 2) % visualMotions.length]!], visualVersion: 2,
    codePlacement: Math.floor(index / 6) % 2 ? 'after-approach' : 'end',
    costStyle: (['standard', 'bullets', 'compact'] as const)[Math.floor(index / 12) % 3]! };
}

export const layoutGuidance: Record<ArticlePresentation['layout'], string> = {
  notebook: 'A compact notebook: observation, three actions, visual trace, and a small invariant callout.',
  questions: 'Answer short reader questions: why this idea, what to do, what stays true, and a tiny worked example.',
  'example-first': 'Lead with one tiny concrete worked example, then explain the idea it reveals and the recipe.',
  recipe: 'A practical recipe: give the key ingredient, concise steps, a test drive and the reason it works.',
  interview: 'An interview brief: state the insight, explain the decision rule, demonstrate it and finish with the invariant.',
  'field-guide': 'A visual field guide: open with the pattern to recognize, then the invariant, trace and implementation steps.',
};
