import { CURRENT_VISUAL_VERSION, type ArticlePresentation } from './presentationStyles';
import { visualPlanSchema, VisualPlan } from './visuals';

/** Identical demonstration data makes style comparisons independent of AI content. */
export function visualPreviewPlans(presentation: ArticlePresentation): VisualPlan[] {
  return ([0, 1] as const).map(index => visualPlanSchema.parse({
    id: `visual-${index + 1}`, after: index ? 'dryRun' : 'intuition',
    title: presentation.scenes ? index ? 'Find the matching pair' : 'Look up the missing value' : 'Follow one update',
    caption: presentation.scenes ? index ? 'Follow the complete search for target 10.' : 'A lookup finds the number that makes the target.' :
      'Style preview: apply the same update once.',
    terrain: presentation.visualVersion === CURRENT_VISUAL_VERSION ? 'sequence' : undefined,
    scene: presentation.scenes?.[index], direction: presentation.directions?.[index],
    layout: presentation.diagrams[index], theme: presentation.themes[index], motion: presentation.motions?.[index],
    frames: presentation.scenes ? (index ? [
      { label: 'Start with target 10', items: ['2', '1', '8', '4'], active: [], state: 'Seen values: empty', metric: 'Target = 10', note: 'Read the values from left to right.' },
      { label: 'Store the first value', items: ['2', '1', '8', '4'], active: [0], state: 'Need 8, so remember 2 at index 0.', metric: 'Seen = {2}', note: 'The match has not arrived yet.' },
      { label: 'Read the second value', items: ['2', '1', '8', '4'], active: [1], state: 'Need 9, so remember 1 at index 1.', metric: 'Seen = {2, 1}', note: 'The lookup misses again.' },
      { label: 'Find the match', items: ['2', '1', '8', '4'], active: [0, 2], state: '8 needs 2, already stored at index 0.', metric: 'Return [0, 2]', note: 'Stop as soon as the pair is found.' },
    ] : [
      { label: 'Read the current value', items: ['5', '3'], active: [1], state: 'The target is 8 and the current value is 3.', metric: 'Current = 3', note: 'The previous value, 5, is already stored.' },
      { label: 'Compute the complement', items: ['5', '3'], active: [1], state: 'Subtract the current value from the target.', metric: '8 − 3 = 5', note: 'Only the missing value needs a lookup.' },
      { label: 'Look up the complement', items: ['5', '3'], active: [0, 1], state: '5 is stored, so these values form a pair.', metric: '5 + 3 = 8', note: 'The two values come from different indices.' },
    ]) : [
      { label: 'Before the update', items: ['index = 0', 'value = 4', 'total = 0', 'pending = 1'], active: [1],
        state: 'Read value = 4', metric: 'updates = 0', note: 'The selected value has not been added yet.' },
      { label: 'After the update', items: ['index = 0', 'value = 4', 'total = 4', 'pending = 0'], active: [2],
        state: 'total = 0 + 4', metric: 'updates = 1', note: 'Apply the update once; the total becomes four.' },
    ],
  }));
}

