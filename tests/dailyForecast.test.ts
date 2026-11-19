import { afterEach, describe, expect, it, vi } from 'vitest';
import { predictNextDaily, validateForecastOrder } from '../src/solutionPosts/dailyForecast';

const now = new Date('2026-01-01T17:00:00Z');
const question = (titleSlug: string, number = '10') => ({
  titleSlug, title: titleSlug, questionFrontendId: number, difficulty: 'Medium',
  isPaidOnly: titleSlug === 'premium', topicTags: [{ slug: 'sorting' }],
});

function mockPublicFeeds({ stale = false, empty = false } = {}) {
  const entries = [
    ['future', '2026-01-01T18:00:00Z'], ['served', '2026-01-01T15:00:00Z'], ['first', '2026-01-01T13:00:00Z'],
    ['second', '2025-12-31T13:00:00Z'], ['second', '2025-12-31T12:00:00Z'], ['third', '2025-12-29T13:00:00Z'],
    ['unofficial', '2025-12-28T13:00:00Z'], ['premium', '2025-12-27T13:00:00Z'], ['old', '2025-11-01T00:00:00Z'],
  ];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body));
    if (query.includes('ForecastCalendar')) {
      const data: Record<string, unknown> = { activeDailyCodingChallengeQuestion: {
        date: stale ? '2025-12-31' : '2026-01-01', question: { titleSlug: 'served' },
      } };
      for (const [, alias, y, m] of query.matchAll(/(m\d+): dailyCodingChallengeV2\(year: (\d+), month: (\d+)\)/g)) {
        const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
        data[alias] = { challenges: Array.from({ length: days }, (_, i) => {
          const date = `${y}-${m.padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
          return { date, question: question(date === '2026-01-01' ? 'served' : `daily-${date}`, '1') };
        }) };
      }
      return Response.json({ data });
    }
    if (query.includes('ForecastEditorials')) {
      const edges = empty ? [] : entries.map(([questionSlug, createdAt], i) => ({
        node: { uuid: String(i), questionSlug, createdAt, author: { userSlug: 'leetcode' } },
      }));
      return Response.json({ data: { ugcArticleUserSolutionArticles: { totalNum: edges.length, edges } } });
    }
    const data: Record<string, unknown> = {};
    for (const [, ix, slug] of query.matchAll(/q(\d+): question\(titleSlug: "([\w-]+)"\)/g)) {
      const entry = entries.findIndex(([name]) => name === slug);
      data[`q${ix}`] = question(slug, String(100 + entry));
      data[`a${ix}`] = { uuid: slug === 'unofficial' ? 'different' : String(entry) };
    }
    return Response.json({ data });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe('Daily Challenge forecast', () => {
  it('verifies eligible candidates across a year boundary and accepts a valid AI order', async () => {
    mockPublicFeeds();
    const ai = vi.fn(async (_messages, eligible) => {
      expect(eligible).toEqual(['first', 'second', 'third']);
      return ['third', 'first'];
    });
    const forecast = await predictNextDaily(now, ai);
    expect(forecast).toMatchObject({ target: '2026-01-02', method: 'editorials+AI' });
    expect(forecast.picks.map(pick => pick.slug)).toEqual(['third', 'first']);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('falls back to editorial ranking when AI returns a duplicate or unknown problem', async () => {
    mockPublicFeeds();
    const forecast = await predictNextDaily(now, async () => ['first', 'invented']);
    expect(forecast.method).toBe('editorials');
    expect(forecast.picks.map(pick => pick.slug)).toEqual(['first', 'second']);
    expect(() => validateForecastOrder('{"slugs":["first","first"]}', ['first', 'second'])).toThrow();
  });

  it('fails closed with a stale calendar and returns an empty forecast with no eligible editorials', async () => {
    mockPublicFeeds({ stale: true });
    const ai = vi.fn();
    await expect(predictNextDaily(now, ai)).rejects.toThrow('LEETCODE_FORECAST_CALENDAR_INCOMPLETE');
    mockPublicFeeds({ empty: true });
    await expect(predictNextDaily(now, ai)).resolves.toMatchObject({ picks: [], method: 'editorials' });
    expect(ai).not.toHaveBeenCalled();
  });
});
