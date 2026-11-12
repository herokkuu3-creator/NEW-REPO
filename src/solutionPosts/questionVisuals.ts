import type { SubmissionContext } from './article';
import type { VisualPlan } from './visuals';
import { OutputValidationError } from './router';
import type { IllustrationKind } from './visualStyles';

export function questionIllustration(context: SubmissionContext): IllustrationKind {
  const tags = new Set(context.topicTags.map(tag => tag.slug));
  const code = context.articleImplementation?.code ?? context.code;
  if (/^climbing-stairs(?:-|$)/.test(context.slug)) return 'steps';
  if (tags.has('matrix') || /flood-fill|island|grid|maze/.test(context.slug)) return 'grid';
  if (/\bTreeNode\b/.test(code) || tags.has('binary-tree') || tags.has('binary-search-tree')) return 'tree';
  if (tags.has('graph') || tags.has('graph-theory') || tags.has('union-find') || tags.has('topological-sort')) return 'graph';
  if (tags.has('sliding-window')) return 'window';
  if (tags.has('binary-search') && /(?:\b(?:mid|middle)\b|lower_bound|upper_bound|bisect)/i.test(code)) return 'search';
  if ((tags.has('stack') || tags.has('monotonic-stack')) && /\b(?:stack|Stack)\b|(?:push|pop)\s*\(/.test(code)) return 'stack';
  if (tags.has('queue') || /\b(?:deque|queue)\s*[<(]/.test(code)) return 'queue';
  if (tags.has('backtracking') || tags.has('greedy')) return 'decision';
  return 'sequence';
}

const directions: Record<IllustrationKind, string> = {
  steps: 'Show exact step indices and their costs. Label items as best[0]=0, best[1]=INF, and so on, keeping each item short.',
  grid: 'Both GIFs must show the real input cells on a small board. In EVERY frame, items are cell values only, and cells is a [row,column] pair for each value. Keep the same board coordinates through a GIF. Use a 2 by 2 example where valid. Put row counts, column counts, or other bookkeeping in state or metric; they are not board cells.',
  tree: 'Show actual tree nodes. Set "edges" to pairs of visible item indices [parent,child] for real links only. Include both endpoints for every link.',
  graph: 'Show actual vertices. Set "edges" to pairs of visible item indices for real edges only. Include both endpoints for every link.',
  stack: 'List the stack from bottom to top so the final item is on top. Focus on what is pushed, kept or removed.',
  queue: 'List values from front to back. Focus on where an item enters or leaves the queue.',
  window: 'List visible array values left to right. Set "range" to the inclusive [first,last] indices of the current window in the visible items.',
  search: 'List the visible candidates in order. Set "range" to the inclusive [first,last] visible indices still in the search interval. Omit it when empty.',
  sequence: 'Show the actual values or entries in their real order. Make the active indices track the entries that change.',
  decision: 'Show the actual alternatives considered at each step. Highlight the chosen alternative and explain its consequence.',
};

export function questionStoryboard(context: SubmissionContext): string {
  return directions[questionIllustration(context)] +
    ' The only optional geometry fields per frame are cells, edges and range. Omit any field that would require inventing data.';
}

export function gridFrame(frame: VisualPlan['frames'][number]): VisualPlan['frames'][number] {
  if (frame.cells) return frame;
  const explicit = frame.items.map(item => /^\s*[[(](-?\d+)\s*,\s*(-?\d+)[\])]\s*[:=]\s*(.+)$/.exec(item));
  const cells = explicit.flatMap(match => match ? [[Number(match[1]), Number(match[2])] as [number, number]] : []);
  if (cells.length !== frame.items.length || new Set(cells.map(cell => cell.join(','))).size !== cells.length ||
      cells.some(cell => cell.some(index => Math.abs(index) > 100))) {
    throw new OutputValidationError('GRID_CELLS_REQUIRED');
  }
  return { ...frame, cells, items: explicit.map(match => match![3]!) };
}
