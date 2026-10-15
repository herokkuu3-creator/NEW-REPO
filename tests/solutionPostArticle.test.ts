import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { AIModelRouter, RoutingError } from '../src/solutionPosts/router';
import { articleSchema, contextSchema, generateArticle, renderArticle, selectStyle, validateArticle } from '../src/solutionPosts/article';

export const context = contextSchema.parse({ accountId: 'a', username: 'alice', problemId: '1', slug: 'example',
  title: 'Distinct squares', difficulty: 'Easy', problem: 'Sum squares of distinct counts of all subarrays.',
  submissionId: '123', language: 'cpp', code: 'class Solution {\r\n// exact\r\n};\r\n', challengeDate: '2026-10-15' });
const mandatoryVisuals = [
  { id: 'visual-1', after: 'intuition', title: 'Each interval grows a set', caption: 'Watch a new value increase the distinct count.', theme: 'aurora', frames: [
    { label: 'Start', items: ['1', '2'], active: [0], state: 'set={1}', metric: 'distinct = 1', note: 'The first value starts the set.' },
    { label: 'Extend', items: ['1', '2'], active: [0, 1], state: 'set={1,2}', metric: 'distinct = 2', note: 'A new value grows the contribution.' },
  ] },
  { id: 'visual-2', after: 'dryRun', title: 'Square the live count', caption: 'The running answer receives each interval contribution.', theme: 'ocean', frames: [
    { label: 'First interval', items: ['1', '2'], active: [0], state: 'answer = 1', metric: '+1', note: 'One distinct value contributes one.' },
    { label: 'Second interval', items: ['1', '2'], active: [0, 1], state: 'answer = 5', metric: '+4', note: 'Two distinct values contribute four.' },
  ] },
];
export const article = articleSchema.parse({ title: '✨ Count Once, Square It! | A Simple Set Walkthrough',
  sections: ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'].map(kind => ({ kind, heading: `${kind} explained`,
    markdown: 'Fix the left boundary. Extend the right boundary and insert each value into a fresh set. Square its size for each interval.' })),
  time: { bound: 'O(n^2)', reason: 'There are n(n+1)/2 intervals. Hash insertion takes expected constant time for each interval.' },
  space: { bound: 'O(n)', reason: 'The set holds at most n distinct input values for one left boundary at a time.' },
  visuals: mandatoryVisuals });
const options = { apiKey: 'secret-test-key', baseUrl: 'https://example.test/v1', models: ['terra', 'luna'], timeoutMs: 1000, retries: 1, maxTokens: 4096 };
const complete = (content: string, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }], usage: { total_tokens: 20 } });
function client() { return { models: { list: vi.fn(async () => ({ data: [{ id: 'terra' }, { id: 'luna' }] })) },
  chat: { completions: { create: vi.fn() } } }; }

describe('solution articles', () => {
  it('preserves source bytes including CRLF and trailing newlines exactly once', () => {
    const result = renderArticle(article, context);
    expect(result.split(context.code)).toHaveLength(2);
    expect(result).toContain('```cpp\n' + context.code + '\n```');
  });
  it('chooses a suitable style without immediately repeating it', () => {
    const c = { ...context, code: 'unordered_set<int> st;' };
    const first = selectStyle(c, []);
    expect(selectStyle(c, [first])).not.toBe(first);
  });
  it.each(['TODO', '<script>alert(1)</script>', '![visual](https://example.com/x.gif)', '```cpp\nclass Solution {};\n```'])('rejects unsafe or placeholder prose: %s', unsafe => {
    const copy = structuredClone(article); copy.sections[0]!.markdown += unsafe;
    expect(() => validateArticle(JSON.stringify(copy), context)).toThrow();
  });
  it('requires all concepts and valid complexity', () => {
    const copy = structuredClone(article); copy.sections[0]!.kind = 'approach';
    expect(() => validateArticle(JSON.stringify(copy), context)).toThrow();
    expect(() => articleSchema.parse({ ...article, time: { bound: 'fast', reason: 'a'.repeat(50) } })).toThrow();
  });
  it('requires two distinct, moving GIF plans in the required explanatory positions', () => {
    const none = structuredClone(article); none.visuals = [];
    expect(() => validateArticle(JSON.stringify(none), context)).toThrow('TWO_GIFS_REQUIRED');
    const misplaced = structuredClone(article); misplaced.visuals[1]!.after = 'approach';
    expect(() => validateArticle(JSON.stringify(misplaced), context)).toThrow('GIF_PLACEMENT_REQUIRED');
    const staticFrames = structuredClone(article); staticFrames.visuals[0]!.frames[1] = structuredClone(staticFrames.visuals[0]!.frames[0]!);
    expect(() => validateArticle(JSON.stringify(staticFrames), context)).toThrow('Animation frames must show a state change');
  });
  it('accepts qualified expected/worst-case complexity without losing either bound', () => {
    const copy = structuredClone(article); copy.time.bound = 'O(n²) expected, O(n³) worst-case';
    expect(validateArticle(JSON.stringify(copy), context).time.bound).toBe(copy.time.bound);
  });
  it('treats exact C++ template types as code, and wraps unfenced types for Markdown', () => {
    const c = { ...context, code: 'unordered_set<int> st;' };
    const copy = structuredClone(article); copy.sections[0]!.markdown += ' Use unordered_set<int> here.';
    expect(() => validateArticle(JSON.stringify(copy), c)).not.toThrow();
    expect(renderArticle(copy, c)).toContain('Use `unordered_set<int>` here.');
    copy.sections[0]!.markdown += ' <script>alert(1)</script>';
    expect(() => validateArticle(JSON.stringify(copy), c)).toThrow();
  });
  it('rejects repeated titles', () => expect(() => validateArticle(JSON.stringify(article), context, [article.title])).toThrow());
  it('rejects textbook length, long paragraphs and unsupported title claims', () => {
    const long = structuredClone(article);
    long.sections.forEach(s => s.markdown = ('A useful explanation stays short. ').repeat(10));
    expect(() => validateArticle(JSON.stringify(long), context)).toThrow('READING_BUDGET_EXCEEDED');
    const paragraph = structuredClone(article);
    paragraph.sections[0]!.markdown = 'word '.repeat(46);
    expect(() => validateArticle(JSON.stringify(paragraph), context)).toThrow('READING_BUDGET_EXCEEDED');
    expect(() => validateArticle(JSON.stringify({ ...article, title: '🚀 Fastest solution with a simple set' }), context)).toThrow('INCOMPLETE_OR_UNSUPPORTED');
    expect(() => validateArticle(JSON.stringify({ ...article, title: '🚀 100% speed with this simple set' }), context)).toThrow('INCOMPLETE_OR_UNSUPPORTED');
    expect(() => validateArticle(JSON.stringify({ ...article, title: 'A plain uninviting title without emoji' }), context)).toThrow();
  });
  it('handles backticks in source using a longer fence', () => expect(renderArticle(article, { ...context, code: '// ```' })).toContain('````cpp'));
});

describe('AI model routing', () => {
  it('discovers available IDs and retries transient failures before falling back', async () => {
    const api = client(); const sleep = vi.fn(async () => {});
    api.chat.completions.create.mockRejectedValueOnce(new OpenAI.RateLimitError(429, {}, 'secret-test-key', undefined))
      .mockRejectedValueOnce(new OpenAI.RateLimitError(429, {}, '', undefined))
      .mockResolvedValueOnce(complete('ok'));
    const result = await new AIModelRouter(options, api as never, sleep).generate([], text => text);
    expect(api.chat.completions.create.mock.calls.map(c => (c[0] as { model: string }).model)).toEqual(['terra', 'terra', 'luna']);
    expect(result.model).toBe('luna'); expect(sleep).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.attempts)).not.toContain('secret-test-key');
  });
  it('skips unknown IDs, deduplicates configured models, and validates output', async () => {
    const api = client(); api.chat.completions.create.mockResolvedValue(complete('42'));
    const result = await new AIModelRouter({ ...options, models: ['unknown', 'luna', 'luna'] }, api as never).generate([], JSON.parse);
    expect(result.value).toBe(42); expect(result.attempts[0]?.outcome).toBe('UNAVAILABLE');
    expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
  });
  it('falls back on truncated and invalid content', async () => {
    const api = client(); api.chat.completions.create.mockResolvedValueOnce(complete('{}', 'length')).mockResolvedValueOnce(complete('42'));
    expect((await new AIModelRouter(options, api as never).generate([], JSON.parse)).model).toBe('luna');
  });
  it('applies per-model timeouts and handles a timeout with bounded retry', async () => {
    const api = client(); const sleep = vi.fn(async () => {});
    api.chat.completions.create.mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const router = new AIModelRouter({ ...options, modelTimeoutMs: { terra: 2000 } }, api as never, sleep);
    const error = await router.generate([], s => s).catch(e => e as RoutingError);
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).attempts.map(a => a.outcome)).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
    expect(api.chat.completions.create.mock.calls[0]?.[1]).toEqual({ timeout: 2000 });
  });
  it('stops on authentication failure without cycling models', async () => {
    const api = client(); api.chat.completions.create.mockRejectedValue(new OpenAI.AuthenticationError(401, {}, '', undefined));
    await expect(new AIModelRouter(options, api as never).generate([], s => s)).rejects.toBeInstanceOf(RoutingError);
    expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
  });
  it('advances to the next API key only after a quota-exhaustion response', async () => {
    const first = client(); const second = client(); const advanced = vi.fn(async () => {});
    const quota = new OpenAI.RateLimitError(429, {}, '', undefined);
    Object.defineProperty(quota, 'code', { value: 'insufficient_quota' });
    first.chat.completions.create.mockRejectedValue(quota);
    second.chat.completions.create.mockResolvedValue(complete('ok'));
    const router = new AIModelRouter({ ...options, apiKeys: ['key_one_0001', 'key_two_0002'], retries: 0 }, first as never,
      undefined, undefined, advanced, () => second as never);
    const result = await router.generate([], value => value);
    expect(result.model).toBe('terra');
    expect(result.attempts.map(a => [a.keySlot, a.outcome])).toEqual([[1, 'KEY_EXHAUSTED'], [2, 'SUCCESS']]);
    expect(advanced).toHaveBeenCalledWith('key_one_0001', 'KEY_EXHAUSTED');
  });
  it('keeps an ordinary 429 on the current key', async () => {
    const api = client(); const advanced = vi.fn(async () => {}); const sleep = vi.fn(async () => {});
    api.chat.completions.create.mockRejectedValueOnce(new OpenAI.RateLimitError(429, {}, '', undefined)).mockResolvedValueOnce(complete('ok'));
    const router = new AIModelRouter({ ...options, apiKeys: ['key_one_0001', 'key_two_0002'], retries: 1 }, api as never,
      sleep, undefined, advanced);
    await router.generate([], value => value);
    expect(advanced).not.toHaveBeenCalled();
    expect(api.chat.completions.create.mock.calls).toHaveLength(2);
  });
  it('never guesses models when discovery fails', async () => {
    const api = client(); api.models.list.mockRejectedValue(new Error('secret'));
    await expect(new AIModelRouter(options, api as never).generate([], s => s)).rejects.toBeInstanceOf(RoutingError);
    expect(api.chat.completions.create).not.toHaveBeenCalled();
  });
  it('uses the configured allow-list when model discovery lacks models:read scope', async () => {
    const api = client();
    api.models.list.mockRejectedValue(new OpenAI.PermissionDeniedError(403,
      { code: 'insufficient_scope' }, 'models:read is required', new Headers()));
    api.chat.completions.create.mockResolvedValue(complete('ok'));
    const result = await new AIModelRouter(options, api as never).generate([], value => value);
    expect(result.model).toBe('terra');
    expect(result.attempts[0]).toMatchObject({ model: 'discovery', outcome: 'MODELS_READ_FORBIDDEN' });
    expect(api.chat.completions.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'terra' }), expect.any(Object));
  });
  it('requires a separate successful technical review', async () => {
    const api = client(); api.chat.completions.create.mockResolvedValueOnce(complete(JSON.stringify(article)))
      .mockResolvedValueOnce(complete('{"approved":false,"issues":["wrong complexity"]}'))
      .mockResolvedValueOnce(complete('{"approved":false,"issues":["wrong trace"]}'));
    await expect(generateArticle(new AIModelRouter(options, api as never), context, [])).rejects.toBeInstanceOf(RoutingError);
    expect(api.chat.completions.create).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])('resolves both GIFs after review and keeps trace tables only for offline fallback: %s', async hostFails => {
    const draft = structuredClone(article);
    const api = client();
    api.chat.completions.create.mockResolvedValueOnce(complete(JSON.stringify(draft)))
      .mockResolvedValueOnce(complete('{"approved":true,"issues":[]}'));
    const resolve = vi.fn(async () => {
      expect(api.chat.completions.create).toHaveBeenCalledTimes(2);
      if (hostFails) throw new Error('Host unavailable');
      return draft.visuals.map((visual, index) => ({ id: visual.id, url: `https://assets.example.test/${index}.gif`, alt: visual.caption }));
    });
    const result = await generateArticle(new AIModelRouter(options, api as never), context, [], resolve);
    expect(resolve).toHaveBeenCalledWith(draft.visuals);
    expect(result.visualFallback).toBe(hostFails);
    expect(result.markdown).toContain(hostFails ? '| Step | State | Result |' : 'https://assets.example.test/0.gif');
    expect(result.assets).toHaveLength(hostFails ? 0 : 2);
    const request = api.chat.completions.create.mock.calls[1]![0] as { messages: { content: string }[] };
    expect(request.messages[1]!.content).toContain('Second interval');
  });
});
