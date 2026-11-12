import type { SubmissionContext } from './article';
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
  grid: 'Show a small set of real cells. Set "cells" to a [row,column] pair for each item in the same order. Keep coordinates stable across frames.',
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
