import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const h = vi.hoisted(() => ({ states: new Map<string, string>() }));
vi.mock('../src/database/prisma', () => ({ prisma: { systemState: {
  findUnique: async ({ where }: any) => h.states.has(where.key) ? { value: h.states.get(where.key) } : null,
  create: async ({ data }: any) => { if (h.states.has(data.key)) throw Object.assign(Error(), { code: 'P2002' }); h.states.set(data.key, data.value); },
  updateMany: async ({ where, data }: any) => { if (h.states.get(where.key) !== where.value) return { count: 0 }; h.states.set(where.key, data.value); return { count: 1 }; },
} } }));
import { reserveArticlePresentation, presentationVariant } from '../src/solutionPosts/presentation';
import { articleSchema, contextSchema, renderArticle, titleIncludesQuestionName } from '../src/solutionPosts/article';
import { renderVisualGif, renderVisualFrame, visualPlanSchema } from '../src/solutionPosts/visuals';
const context = contextSchema.parse({ accountId: 'a', username: 'a', problemId: '1', slug: 'two-sum', title: 'Two Sum',
  difficulty: 'Easy', problem: 'An example', submissionId: '1', code: 'class Solution {};', language: 'cpp', challengeDate: '2026-11-06' });
beforeEach(() => h.states.clear());
it('assigns different layouts and diagrams across accounts while keeping retries stable', async () => {
  const [a, b] = await Promise.all([reserveArticlePresentation('a', 'two-sum'), reserveArticlePresentation('b', 'two-sum')]);
  expect(a.layout).not.toBe(b.layout); expect(a.diagrams).not.toEqual(b.diagrams);
  expect(await reserveArticlePresentation('a', 'two-sum')).toEqual(a);
});
it('uses different section order, hierarchy, and complexity formatting with exact source retained', () => {
  const draft = articleSchema.parse({ title: '✨ One Lookup Can Reveal the Missing Partner',
    sections: ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'].map(kind => ({ kind, heading: kind, markdown: 'A short useful explanation of the decision.' })),
    time: { bound: 'O(n)', reason: 'One pass visits n input items.' }, space: { bound: 'O(n)', reason: 'The table holds n input items.' } });
  const notebook = renderArticle(draft, { ...context, presentation: presentationVariant(0) });
  const questions = renderArticle(draft, { ...context, presentation: presentationVariant(1) });
  expect(notebook).toContain('**The observation**'); expect(questions).toContain('### What is the key idea?');
  expect(notebook).toContain('| Time |'); expect(questions).toContain('**Time:**');
  expect(notebook.indexOf('A small recipe')).toBeLessThan(notebook.indexOf('> A short'));
  expect(questions.indexOf('Why is that enough?')).toBeLessThan(questions.indexOf('What do we do?'));
  expect(notebook.split(context.code)).toHaveLength(2); expect(questions.split(context.code)).toHaveLength(2);
});
it('rejects the full question name and long title fragments but permits a technique hook', () => {
  expect(titleIncludesQuestionName('✨ Two Sum with a table', context)).toBe(true);
  expect(titleIncludesQuestionName('✨ One Lookup Reveals the Missing Partner', context)).toBe(false);
  expect(titleIncludesQuestionName('✨ Distance Value Between Two Arrays, Quickly', {
    title: 'Find the Distance Value Between Two Arrays', slug: 'find-the-distance-value-between-two-arrays' })).toBe(true);
});
it('renders different diagram geometries and animated highlights without adding numeric states', async () => {
  const base = visualPlanSchema.parse({ id: 'visual-1', after: 'intuition', title: 'Watch the lookup', caption: 'Follow the active candidate.',
    frames: [
      { label: 'Before', items: ['4', '8'], active: [0], state: 'answer=0', metric: '0', note: 'Inspect the candidate.' },
      { label: 'After', items: ['4', '8'], active: [1], state: 'answer=1', metric: '1', note: 'The answer advances.' },
    ] });
  const rendered: string[] = [];
  for (const layout of ['strip', 'ledger', 'focus'] as const) {
    const plan = { ...base, layout }; rendered.push(renderVisualFrame(plan, 0));
    const bytes = await renderVisualGif(plan); const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(6); expect(metadata.delay).toEqual([120, 160, 1170, 120, 160, 2020]);
    expect(renderVisualFrame(plan, 0, .25)).not.toBe(renderVisualFrame(plan, 0, 1));
    expect(bytes.length).toBeLessThan(500000);
  }
  expect(new Set(rendered).size).toBe(3);
});
