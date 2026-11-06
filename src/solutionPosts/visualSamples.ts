import type { ArticlePresentation } from './presentationStyles';
import { visualPlanSchema, VisualPlan } from './visuals';

/** Identical demonstration data makes style comparisons independent of AI content. */
export function visualPreviewPlans(presentation: ArticlePresentation): VisualPlan[] {
  return ([0, 1] as const).map(index => visualPlanSchema.parse({
    id: `visual-${index + 1}`, after: index ? 'dryRun' : 'intuition',
    title: 'Follow one update', caption: 'Style preview: apply the same update once.',
    layout: presentation.diagrams[index], theme: presentation.themes[index], motion: presentation.motions?.[index],
    frames: [
      { label: 'Before the update', items: ['index = 0', 'value = 4', 'total = 0', 'pending = 1'], active: [1],
        state: 'Read value = 4', metric: 'updates = 0', note: 'The selected value has not been added yet.' },
      { label: 'After the update', items: ['index = 0', 'value = 4', 'total = 4', 'pending = 0'], active: [2],
        state: 'total = 0 + 4', metric: 'updates = 1', note: 'Apply the update once; the total becomes four.' },
    ],
  }));
}

