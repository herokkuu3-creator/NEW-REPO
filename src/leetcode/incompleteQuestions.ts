import { z } from 'zod';
import { logger } from '../logger';
import type { LeetCodeApi } from './apiClient';

export interface IncompleteQuestion {
  number: number;
  slug: string;
  title: string;
  status: string | null;
}

export const INCOMPLETE_QUESTION_LIST_QUERY = `
  query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      total: totalNum
      questions: data {
        frontendQuestionId: questionFrontendId
        titleSlug
        title
        paidOnly: isPaidOnly
        status
      }
    }
  }
`;

export const incompleteQuestionListSchema = z.object({
  problemsetQuestionList: z
    .object({
      total: z.number().optional(),
      questions: z.array(
        z.object({
          frontendQuestionId: z.string().optional(),
          titleSlug: z.string().optional(),
          title: z.string().optional(),
          paidOnly: z.boolean().optional(),
          status: z.string().nullable().optional(),
        }),
      ).optional(),
    })
    .nullable()
    .optional(),
});

export type IncompleteQuestionsApi = Pick<LeetCodeApi, 'graphql'>;

/**
 * Fetches the first N incomplete LeetCode questions in ascending order from #1.
 * Matches questions that are either:
 *   1) Left unsolved (never attempted / not started), OR
 *   2) Attempted but not accepted (status != 'ac')
 * Excludes premium-locked questions (paidOnly) since non-premium accounts cannot submit them.
 */
export async function fetchIncompleteQuestions(
  api: IncompleteQuestionsApi,
  count: number,
  pageSize = 50,
): Promise<IncompleteQuestion[]> {
  const result: IncompleteQuestion[] = [];
  const targetCount = Math.max(1, count);
  let skip = 0;
  const maxPages = 40; // up to 2000 questions checked

  for (let page = 0; page < maxPages && result.length < targetCount; page++) {
    const data = await api.graphql(
      INCOMPLETE_QUESTION_LIST_QUERY,
      {
        categorySlug: '',
        skip,
        limit: pageSize,
        filters: {},
      },
      incompleteQuestionListSchema,
    );

    const questions = data?.problemsetQuestionList?.questions ?? [];
    if (questions.length === 0) break;

    for (const q of questions) {
      if (q.paidOnly) continue; // Skip premium locked

      const num = Number(q.frontendQuestionId);
      if (!Number.isFinite(num) || num < 1) continue;

      const st = (q.status ?? '').toLowerCase().trim();
      // Skip accepted / solved questions
      if (st === 'ac' || st === 'solved') continue;

      result.push({
        number: num,
        slug: q.titleSlug || '',
        title: q.title || `Question #${num}`,
        status: q.status ?? null,
      });

      if (result.length >= targetCount) break;
    }

    skip += pageSize;
    const total = data?.problemsetQuestionList?.total ?? 0;
    if (skip >= total) break;
  }

  logger.info(
    { requestedCount: targetCount, foundCount: result.length, firstFew: result.slice(0, 5).map((q) => q.number) },
    'resolved incomplete questions list',
  );

  return result;
}
