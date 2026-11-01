import { describe, expect, it, vi } from 'vitest';
import { contextSchema, generateArticle, ArticleReviewError } from '../src/solutionPosts/article';
import { FirecrawlAgentRouter } from '../src/solutionPosts/firecrawlAgent';

const context = contextSchema.parse({ accountId: 'a', username: 'alice', problemId: '1', slug: 'example', title: 'Example',
  difficulty: 'Easy', problem: 'Count the distinct values in the input.', submissionId: '123', language: 'cpp',
  code: 'class Solution { public: int count() { return 2; } };', challengeDate: '2026-10-31' });
const frames = [
  { label: 'Start', items: ['1', '2'], active: [0], state: 'seen=1', metric: 'count=1', note: 'The first value is new.' },
  { label: 'Next', items: ['1', '2'], active: [1], state: 'seen=2', metric: 'count=2', note: 'The second value is new.' },
];
const article = { title: '✨ Count Distinct Values with a Simple Set',
  sections: ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'].map(kind => ({ kind, heading: `${kind} explained`,
    markdown: 'Insert each value into a set.<br>Each different value remains exactly once, so the set size gives the distinct count.' })),
  time: { bound: 'O(n)', reason: 'Each of the n values is inserted into the set once.' },
  space: { bound: 'O(n)', reason: 'The set can contain up to n distinct values at once.' },
  visuals: [{ id: 'visual-1', after: 'intuition', title: 'Track values', caption: 'Watch new values enter the set.', theme: 'aurora', frames },
    { id: 'visual-2', after: 'dryRun', title: 'Trace counts', caption: 'Follow each change to the count.', theme: 'ocean', frames }] };
const done = (value: unknown) => ({ value, model: 'firecrawl/spark-2', attempts: [{ model: 'firecrawl/spark-2', attempt: 1, outcome: 'SUCCESS', elapsedMs: 1 }] });
const assets = [{ id: 'visual-1', url: 'https://example.com/one.gif', alt: 'First animation' },
  { id: 'visual-2', url: 'https://example.com/two.gif', alt: 'Second animation' }];
describe('Firecrawl Agent article workflow', () => {
  it('requests bounded frame items and gives actionable length feedback when a draft violates the limit', async () => {
    const router = new FirecrawlAgentRouter('fc-test-key-1234567890');
    const invalid = structuredClone(article);
    invalid.visuals[1].frames[1].items[0] = 'a'.repeat(25);
    const run = vi.spyOn(router, 'generateStructured').mockResolvedValueOnce(done(invalid))
      .mockResolvedValueOnce(done(article)).mockResolvedValueOnce(done({ approved: true, issues: [] }));
    await generateArticle(router, context, [], async () => assets);
    const [messages, schema] = run.mock.calls[0];
    expect(messages[0].content).toContain('at most 24 characters');
    expect((schema as any).properties.visuals.items.properties.frames.items.properties.items.items.maxLength).toBe(24);
    expect(JSON.stringify(run.mock.calls[1][0])).toContain('24');
  });
  it('repairs a rejected draft, requires a separate review, and renders two GIFs', async () => {
    const router = new FirecrawlAgentRouter('fc-test-key-1234567890');
    const run = vi.spyOn(router, 'generateStructured').mockResolvedValueOnce(done(article))
      .mockResolvedValueOnce(done({ approved: false, issues: ['Fix the trace.'] }))
      .mockResolvedValueOnce(done(article)).mockResolvedValueOnce(done({ approved: true, issues: [] }));
    const resolve = vi.fn(async () => assets);
    const result = await generateArticle(router, context, [], resolve);
    expect(run).toHaveBeenCalledTimes(4); expect(resolve).toHaveBeenCalledOnce();
    expect(result.visualFallback).toBe(false); expect(result.markdown).toContain(context.code);
    expect(result.markdown).toContain('one.gif'); expect(result.markdown).toContain('two.gif');
    expect(result.markdown).not.toContain('<br>');
  });
  it('never publishes a draft rejected by both reviews', async () => {
    const router = new FirecrawlAgentRouter('fc-test-key-1234567890');
    vi.spyOn(router, 'generateStructured').mockResolvedValueOnce(done(article))
      .mockResolvedValueOnce(done({ approved: false, issues: ['Wrong state'] }))
      .mockResolvedValueOnce(done(article)).mockResolvedValueOnce(done({ approved: false, issues: ['Still wrong'] }));
    const resolve = vi.fn(async () => assets);
    await expect(generateArticle(router, context, [], resolve)).rejects.toBeInstanceOf(ArticleReviewError);
    expect(resolve).not.toHaveBeenCalled();
  });
});
