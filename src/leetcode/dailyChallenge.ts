import { Page } from 'playwright';
import { z } from 'zod';
import { leetcodeGraphQL } from './graphql';
import { logger } from '../logger';

/**
 * Daily Challenge discovery — network/API first, no crawling.
 *
 * The worker queries ONLY the daily-challenge endpoint and the single
 * question it points to. Nothing else on the site is touched.
 */

const dailySchema = z.object({
  activeDailyCodingChallengeQuestion: z
    .object({
      date: z.string(), // YYYY-MM-DD (LeetCode's own date)
      link: z.string(),
      question: z.object({
        questionFrontendId: z.string(),
        title: z.string(),
        titleSlug: z.string(),
        difficulty: z.string(),
        isPaidOnly: z.boolean(),
      }),
    })
    .nullable(),
});

const questionSchema = z.object({
  question: z.object({
    questionFrontendId: z.string(),
    title: z.string(),
    titleSlug: z.string(),
    difficulty: z.string(),
    content: z.string().nullable(),
    exampleTestcases: z.string().nullable(),
    metaData: z.string().nullable(),
    codeSnippets: z
      .array(z.object({ lang: z.string(), langSlug: z.string(), code: z.string() }))
      .nullable(),
  }),
});

const DAILY_QUERY = `
  query questionOfToday {
    activeDailyCodingChallengeQuestion {
      date
      link
      question {
        questionFrontendId
        title
        titleSlug
        difficulty
        isPaidOnly
      }
    }
  }
`;

const QUESTION_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId
      title
      titleSlug
      difficulty
      content
      exampleTestcases
      metaData
      codeSnippets { lang langSlug code }
    }
  }
`;

export interface DailyChallengeInfo {
  date: string;
  slug: string;
  link: string;
  frontendId: string;
  title: string;
  difficulty: string;
  isPaidOnly: boolean;
}

export interface RawQuestionData {
  frontendId: string;
  title: string;
  slug: string;
  difficulty: string;
  contentHtml: string;
  exampleTestcases: string;
  metaData: Record<string, unknown> | null;
  codeSnippets: { lang: string; langSlug: string; code: string }[];
}

export class DailyProblemNotFoundError extends Error {
  constructor() {
    super('No active daily challenge returned by LeetCode');
    this.name = 'DailyProblemNotFoundError';
  }
}

/** Returns today's daily challenge pointer, or throws DailyProblemNotFoundError. */
export async function fetchDailyChallenge(page: Page): Promise<DailyChallengeInfo> {
  const data = await leetcodeGraphQL(page, DAILY_QUERY, {}, dailySchema);
  const node = data.activeDailyCodingChallengeQuestion;
  if (!node) {
    throw new DailyProblemNotFoundError();
  }
  const info: DailyChallengeInfo = {
    date: node.date,
    slug: node.question.titleSlug,
    link: node.link,
    frontendId: node.question.questionFrontendId,
    title: node.question.title,
    difficulty: node.question.difficulty,
    isPaidOnly: node.question.isPaidOnly,
  };
  logger.info(
    { date: info.date, slug: info.slug, difficulty: info.difficulty, paidOnly: info.isPaidOnly },
    'daily challenge located',
  );
  return info;
}

/** Fetches the full problem payload for one slug — exactly one question, no crawl. */
export async function fetchQuestionData(page: Page, slug: string): Promise<RawQuestionData> {
  const data = await leetcodeGraphQL(page, QUESTION_QUERY, { titleSlug: slug }, questionSchema);
  const q = data.question;

  let metaData: Record<string, unknown> | null = null;
  if (q.metaData) {
    try {
      metaData = JSON.parse(q.metaData) as Record<string, unknown>;
    } catch {
      logger.warn({ slug }, 'question metaData was not valid JSON — continuing without it');
    }
  }

  return {
    frontendId: q.questionFrontendId,
    title: q.title,
    slug: q.titleSlug,
    difficulty: q.difficulty,
    contentHtml: q.content ?? '',
    exampleTestcases: q.exampleTestcases ?? '',
    metaData,
    codeSnippets: q.codeSnippets ?? [],
  };
}
