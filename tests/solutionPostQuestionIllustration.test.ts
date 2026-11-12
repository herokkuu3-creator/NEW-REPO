import { expect, it } from 'vitest';
import sharp from 'sharp';
import { contextSchema } from '../src/solutionPosts/article';
import { questionIllustration } from '../src/solutionPosts/questionVisuals';
import { renderVisualFrame, renderVisualGif, visualPlanSchema } from '../src/solutionPosts/visuals';

const context = (slug: string, tags: string[], code = 'class Solution {}') => contextSchema.parse({
  accountId: 'acct', username: 'reader', problemId: '42', slug, title: 'Test', difficulty: 'Medium',
  problem: 'Illustrate the algorithm on a small input.', submissionId: '42', language: 'cpp', code,
  challengeDate: '2026-11-12', topicTags: tags.map(slug => ({ slug, name: slug })),
});

it('chooses geometry from the real question and the implemented technique', () => {
  expect(questionIllustration(context('climbing-stairs-ii', ['dynamic-programming']))).toBe('steps');
  expect(questionIllustration(context('count-servers-that-communicate', ['matrix', 'union-find']))).toBe('grid');
  expect(questionIllustration(context('tree-depth', ['stack'], 'int depth(TreeNode* root) { return 0; }'))).toBe('tree');
  expect(questionIllustration(context('network-delay-time', ['graph', 'heap-priority-queue']))).toBe('graph');
  expect(questionIllustration(context('maximum-sum-subarray', ['array', 'sliding-window']))).toBe('window');
  expect(questionIllustration(context('search-insert-position', ['binary-search'], 'auto mid = (lo + hi) / 2;'))).toBe('search');
  expect(questionIllustration(context('daily-temperatures', ['monotonic-stack'], 'stack<int> pending;'))).toBe('stack');
});

const fixture = {
  id: 'visual-2', after: 'dryRun', title: 'Watch the active region', caption: 'Follow the current operation.',
  frames: [
    { label: 'Start', items: ['A', 'B', 'C'], active: [0], state: 'Begin with A.', metric: 'Visited 1', note: 'Read the first item.' },
    { label: 'Advance', items: ['A', 'B', 'C'], active: [1], state: 'Continue with B.', metric: 'Visited 2', note: 'Move to the next item.' },
    { label: 'Finish', items: ['A', 'B', 'C'], active: [2], state: 'Reach C.', metric: 'Visited 3', note: 'Finish the trace.' },
  ],
};

it('draws only supplied graph edges and rejects invalid coordinates, links and ranges', () => {
  const graph = visualPlanSchema.parse({ ...fixture, terrain: 'graph' });
  expect(renderVisualFrame(graph, 0)).not.toContain('data-edge=');
  graph.frames[0]!.edges = [[0, 2]];
  const svg = renderVisualFrame(graph, 0);
  expect(svg).toContain('data-edge="0-2"');
  expect(svg).not.toContain('data-edge="0-1"');

  for (const geometry of [{ cells: [[0, 0], [0, 0], [1, 1]] }, { edges: [[0, 3]] }, { range: [2, 1] }]) {
    const invalid = { ...fixture, frames: fixture.frames.map((frame, index) => index === 0 ? { ...frame, ...geometry } : frame) };
    expect(visualPlanSchema.safeParse(invalid).success).toBe(false);
  }
});

it('can introduce an interval after the number of visible values changes', () => {
  const plan = visualPlanSchema.parse({ ...fixture, terrain: 'window', frames: [
    { ...fixture.frames[0], items: ['A'] }, { ...fixture.frames[1], range: [1, 2] }, fixture.frames[2],
  ] });
  expect(renderVisualFrame(plan, 1, .5)).toContain('data-range="1-2"');
});

it('encodes distinct grid and tree GIFs while keeping the traced state count', async () => {
  const grid = visualPlanSchema.parse({ ...fixture, terrain: 'grid',
    frames: fixture.frames.map(frame => ({ ...frame, cells: [[0, 0], [0, 1], [1, 1]] })) });
  const tree = visualPlanSchema.parse({ ...fixture, terrain: 'tree',
    frames: fixture.frames.map(frame => ({ ...frame, edges: [[0, 1], [0, 2]] })) });
  const [gridGif, treeGif] = await Promise.all([renderVisualGif(grid), renderVisualGif(tree)]);
  expect(gridGif.equals(treeGif)).toBe(false);
  for (const gif of [gridGif, treeGif]) {
    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.pages).toBe(13);
    expect(gif.length).toBeLessThan(500000);
  }
});
