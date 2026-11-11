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
  format: z.object({ index: z.number().int().nonnegative(), optimization: z.boolean() }).optional(),
});
export type ArticlePresentation = z.infer<typeof presentationSchema>;
const openingOrders = [
  'intuition approach costs code dryRun correctness takeaways',
  'dryRun intuition correctness code approach costs takeaways',
  'approach code intuition takeaways correctness costs dryRun',
  'code approach costs correctness dryRun intuition takeaways',
  'intuition correctness costs takeaways approach dryRun code',
  'dryRun costs approach intuition code takeaways correctness',
  'intuition code dryRun costs approach correctness takeaways',
  'approach dryRun correctness intuition costs takeaways code',
  'dryRun intuition takeaways costs code approach correctness',
  'code intuition correctness dryRun approach costs takeaways',
  'intuition costs correctness approach dryRun code takeaways',
  'approach costs code dryRun takeaways intuition correctness',
  'dryRun approach code correctness takeaways costs intuition',
  'intuition takeaways dryRun code costs correctness approach',
  'approach intuition correctness costs takeaways code dryRun',
];
const openings = ['intuition', 'dryRun', 'approach', 'code'];
const articleBlocks = openingOrders[0]!.split(' ');
function remainingOrders(prefix: string[], remaining: string[]): string[] {
  if (!remaining.length) return prefix.at(-1) === 'costs' ? [] : [prefix.join(' ')];
  const choices = prefix.length ? remaining : openings;
  return choices.flatMap(block => remainingOrders([...prefix, block], remaining.filter(item => item !== block)));
}
const articleOrders = [...new Set([...openingOrders, ...remainingOrders([], articleBlocks)])];
const gifSlots = Array.from({ length: 9 }, (_, concept) => Array.from({ length: 9 }, (_, trace) => [concept, trace] as const)
  .filter(([, trace]) => concept !== trace)).flat();
const openingSlots = [[1, 6], [5, 2], [3, 8], [6, 4], [2, 7], [7, 1], [3, 4], [5, 1],
  [4, 0], [2, 5], [1, 5], [6, 3], [8, 1], [4, 6], [0, 7]];

export function articleBlockOrder(index: number): string[] {
  const variant = index % articleOrders.length;
  const order = articleOrders[variant]!.split(' ');
  const initial = openingSlots[variant];
  const start = initial ? gifSlots.findIndex(([a, b]) => a === initial[0] && b === initial[1]) : variant * 5;
  const [concept, trace] = gifSlots[(start + Math.floor(index / articleOrders.length)) % gifSlots.length]!;
  return Array.from({ length: 9 }, (_, slot) => slot === concept ? 'visual-1' : slot === trace ? 'visual-2' : order.shift()!);
}

export function postPresentationVariant(index: number, problemIndex: number, layoutOffset = 0): ArticlePresentation {
  const layout = articleLayouts[index % articleLayouts.length]!;
  const first = (2 * problemIndex + layoutOffset) % accountDiagramLayouts.length;
  const second = (first + 1 + Math.floor(problemIndex / accountDiagramLayouts.length) % 14) % accountDiagramLayouts.length;
  const themeOffset = layoutOffset + Math.floor(problemIndex / accountDiagramLayouts.length);
  const firstTheme = (first + themeOffset) % accountVisualThemes.length;
  const traceTheme = (second + themeOffset + 7) % accountVisualThemes.length;
  return { layout, diagrams: [accountDiagramLayouts[first]!, accountDiagramLayouts[second]!],
    themes: [accountVisualThemes[firstTheme]!, accountVisualThemes[traceTheme === firstTheme ? (traceTheme + 1) % accountVisualThemes.length : traceTheme]!],
    motions: [visualMotions[index % visualMotions.length]!, visualMotions[(index + 2) % visualMotions.length]!],
    visualVersion: 2, codePlacement: 'end', costStyle: (['standard', 'bullets', 'compact'] as const)[index % 3]!,
    format: { index, optimization: problemIndex === 0 } };
}

const visualStories = [
  'Contrast the state just before and just after the key decision.',
  'Track which values move between two groups and why.',
  'Show the smallest edge case that exposes the invariant.',
  'Show how local changes contribute to the final result.',
  'Trace the lifetime of the main variable through updates.',
  'Expose what is discarded, retained, and returned.',
  'Focus on the exact point where two cases diverge.',
] as const;
export function articleVisualGuidance(index: number): string {
  return visualStories[index % visualStories.length]!;
}

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
