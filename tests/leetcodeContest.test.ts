import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEST_QUERY,
  fetchContestBySlug,
  fetchLatestEndedContest,
  fetchRecentContestsByType,
  PAST_CONTESTS_QUERY,
  selectStartingContestQuestions,
} from '../src/leetcode/contest';

describe('leetcode/contest GraphQL helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('paginates pastContests across pages, skips virtual contests, filters by kind, and keeps Medium Q1/Q2 credits untouched', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const graphql = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      const pageNo = Number(variables?.pageNo ?? 1);
      if (pageNo === 1) {
        return {
          data: {
            pastContests: {
              currentPage: 1,
              pageNum: 3,
              totalNum: 50,
              data: [
                {
                  title: 'Virtual Contest',
                  titleSlug: 'biweekly-contest-999',
                  startTime: 1_760_000_000,
                  originStartTime: 1_760_000_000,
                  duration: 5400,
                  isVirtual: true,
                  questions: [],
                },
                {
                  title: 'Weekly Contest 430',
                  titleSlug: 'weekly-contest-430',
                  startTime: 1_760_100_000,
                  originStartTime: 1_760_100_000,
                  duration: 5400,
                  isVirtual: false,
                  questions: [],
                },
                {
                  title: 'Biweekly Contest 150',
                  titleSlug: 'biweekly-contest-150',
                  startTime: null,
                  originStartTime: 1_760_000_000,
                  duration: 5400,
                  isVirtual: false,
                  questions: [
                    { title: 'Q1 Medium Start', titleSlug: 'q1-med', questionId: 3901, credit: 4 },
                    { title: 'Q2 Harder Medium', titleSlug: 'q2-med', questionId: '3902', credit: 5 },
                    { title: 'Q3 Graph', titleSlug: 'q3-graph', questionId: '3903', credit: 5 },
                    { title: 'Q4 Hard', titleSlug: 'q4-hard', questionId: '3904', credit: 6 },
                  ],
                },
              ],
            },
          },
        };
      }
      return {
        data: {
          pastContests: {
            currentPage: 2,
            pageNum: 3,
            totalNum: 50,
            data: [
              {
                title: 'Biweekly Contest 149',
                titleSlug: 'biweekly-contest-149',
                startTime: 1_758_800_000,
                originStartTime: 1_758_800_000,
                duration: 5400,
                isVirtual: false,
                questions: [
                  { title: 'Old Q1', titleSlug: 'old-q1', questionId: '3801', credit: 3 },
                ],
              },
            ],
          },
        },
      };
    });

    const contests = await fetchRecentContestsByType('biweekly', 2, { graphql });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toBe(PAST_CONTESTS_QUERY);
    expect(calls[0]?.variables).toEqual({ pageNo: 1, numPerPage: 25 });
    expect(calls[1]?.variables).toEqual({ pageNo: 2, numPerPage: 25 });

    expect(contests).toHaveLength(2);
    expect(contests[0]).toEqual({
      title: 'Biweekly Contest 150',
      titleSlug: 'biweekly-contest-150',
      kind: 'biweekly',
      startTimeSec: 1_760_000_000,
      endTimeSec: 1_760_005_400,
      questions: [
        { index: 0, label: 'Q1', title: 'Q1 Medium Start', titleSlug: 'q1-med', questionId: '3901', credit: 4 },
        { index: 1, label: 'Q2', title: 'Q2 Harder Medium', titleSlug: 'q2-med', questionId: '3902', credit: 5 },
        { index: 2, label: 'Q3', title: 'Q3 Graph', titleSlug: 'q3-graph', questionId: '3903', credit: 5 },
        { index: 3, label: 'Q4', title: 'Q4 Hard', titleSlug: 'q4-hard', questionId: '3904', credit: 6 },
      ],
    });
    expect(contests[1]?.titleSlug).toBe('biweekly-contest-149');

    const starting = selectStartingContestQuestions(contests[0]!);
    expect(starting.map((q) => [q.index, q.label, q.credit, q.titleSlug])).toEqual([
      [0, 'Q1', 4, 'q1-med'],
      [1, 'Q2', 5, 'q2-med'],
    ]);
  });

  it('caps pagination at 3 pages and supports direct selection indices', async () => {
    const graphql = vi.fn(async (_q: string, vars?: Record<string, unknown>) => ({
      pastContests: {
        currentPage: vars?.pageNo ?? 1,
        pageNum: 10,
        totalNum: 250,
        data: [
          {
            title: `Biweekly ${(vars?.pageNo as number) ?? 1}`,
            titleSlug: `biweekly-contest-${100 - Number(vars?.pageNo ?? 1)}`,
            startTime: 1000,
            originStartTime: 1000,
            duration: 5400,
            isVirtual: false,
            questions: [],
          },
        ],
      },
    }));

    const weekly = await fetchRecentContestsByType('weekly', 2, { graphql });
    expect(weekly).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(3);

    expect(
      selectStartingContestQuestions(
        {
          title: 'Weekly Contest 431',
          titleSlug: 'weekly-contest-431',
          kind: 'weekly',
          startTimeSec: 100,
          endTimeSec: 5500,
          questions: [
            { index: 0, label: 'Q1', title: 'A', titleSlug: 'a', questionId: '1', credit: 3 },
            { index: 1, label: 'Q2', title: 'B', titleSlug: 'b', questionId: '2', credit: 5 },
          ],
        },
        [1, 0, 1]
      ).map((q) => q.titleSlug)
    ).toEqual(['b', 'a']);
  });

  it('fetchContestBySlug fetches contest details via GraphQL and handles null contests', async () => {
    const graphql = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      expect(query).toBe(CONTEST_QUERY);
      if (variables?.titleSlug === 'missing-contest') {
        return { data: { contest: null } };
      }
      return {
        data: {
          contest: {
            title: 'Weekly Contest 432',
            titleSlug: 'weekly-contest-432',
            startTime: 1_761_000_000,
            duration: 5400,
            questions: [
              { title: 'Sum', titleSlug: 'sum-q1', questionId: '5001', credit: 3 },
              { title: 'Grid', titleSlug: 'grid-q2', questionId: '5002', credit: 4 },
            ],
          },
        },
      };
    });

    const found = await fetchContestBySlug('weekly-contest-432', { graphql });
    expect(found).toEqual({
      title: 'Weekly Contest 432',
      titleSlug: 'weekly-contest-432',
      kind: 'weekly',
      startTimeSec: 1_761_000_000,
      endTimeSec: 1_761_005_400,
      questions: [
        { index: 0, label: 'Q1', title: 'Sum', titleSlug: 'sum-q1', questionId: '5001', credit: 3 },
        { index: 1, label: 'Q2', title: 'Grid', titleSlug: 'grid-q2', questionId: '5002', credit: 4 },
      ],
    });

    expect(await fetchContestBySlug('missing-contest', { graphql })).toBeNull();
    expect(await fetchContestBySlug('   ', { graphql })).toBeNull();
  });

  it('fetchLatestEndedContest ignores ongoing contests and returns most recently ended contest', async () => {
    const graphql = vi.fn(async () => ({
      data: {
        pastContests: {
          currentPage: 1,
          pageNum: 1,
          totalNum: 3,
          data: [
            {
              title: 'Weekly Contest 433 (Ongoing)',
              titleSlug: 'weekly-contest-433',
              startTime: 2_000_000,
              originStartTime: 2_000_000,
              duration: 5400, // ends 2_005_400
              isVirtual: false,
              questions: [],
            },
            {
              title: 'Weekly Contest 431 (Older)',
              titleSlug: 'weekly-contest-431',
              startTime: 1_000_000,
              originStartTime: 1_000_000,
              duration: 5400,
              isVirtual: false,
              questions: [],
            },
            {
              title: 'Weekly Contest 432 (Latest Ended)',
              titleSlug: 'weekly-contest-432',
              startTime: 1_900_000,
              originStartTime: 1_900_000,
              duration: 5400, // ends 1_905_400
              isVirtual: false,
              questions: [],
            },
          ],
        },
      },
    }));

    const latest = await fetchLatestEndedContest('weekly', new Date(2_001_000 * 1000), { graphql });
    expect(latest?.titleSlug).toBe('weekly-contest-432');

    const beforeAny = await fetchLatestEndedContest('weekly', new Date(500_000 * 1000), { graphql });
    expect(beforeAny).toBeNull();
  });

  it('uses LeetCode GraphQL POST endpoint by default (never REST contest info) and validates GraphQL errors', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://leetcode.com/graphql');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Referer).toBe('https://leetcode.com/contest/');
      return new Response(
        JSON.stringify({ errors: [{ message: 'rate limited' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchContestBySlug('weekly-contest-432')).rejects.toThrow(
      /LeetCode contest GraphQL error: rate limited/
    );
  });
});
