import { z } from 'zod';

export type ContestKind = 'weekly' | 'biweekly';

export interface ContestQuestionSummary {
  index: 0 | 1 | 2 | 3;
  label: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  title: string;
  titleSlug: string;
  questionId: string;
  credit: number;
}

export interface ContestSummary {
  title: string;
  titleSlug: string;
  kind: ContestKind;
  startTimeSec: number;
  endTimeSec: number; // startTimeSec + duration
  questions: ContestQuestionSummary[];
}

export interface FetchContestsOptions {
  graphql?: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  now?: Date;
}

export const PAST_CONTESTS_QUERY =
  'query pastContests($pageNo: Int!, $numPerPage: Int!) { pastContests(pageNo: $pageNo, numPerPage: $numPerPage) { currentPage pageNum totalNum data { title titleSlug startTime originStartTime duration isVirtual questions { title titleSlug questionId credit } } } }';

export const CONTEST_QUERY =
  'query contest($titleSlug: String!) { contest(titleSlug: $titleSlug) { title titleSlug startTime duration questions { title titleSlug questionId credit } } }';

const LEETCODE_GRAPHQL_URL = 'https://leetcode.com/graphql';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_NUM_PER_PAGE = 25;
const MAX_PAST_CONTEST_PAGES = 3;
const CONTEST_LABELS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

const rawQuestionSchema = z.object({
  title: z.string().min(1),
  titleSlug: z.string().min(1),
  questionId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  credit: z.number().finite().optional().default(0),
});

const rawPastContestItemSchema = z.object({
  title: z.string().min(1),
  titleSlug: z.string().min(1),
  startTime: z.number().finite().nullable().optional(),
  originStartTime: z.number().finite().nullable().optional(),
  duration: z.number().finite().nonnegative(),
  isVirtual: z.boolean().optional().default(false),
  questions: z.array(rawQuestionSchema).optional().default([]),
});

const pastContestsPayloadSchema = z.object({
  pastContests: z
    .object({
      currentPage: z.number().int().optional(),
      pageNum: z.number().int().optional(),
      totalNum: z.number().int().optional(),
      data: z.array(rawPastContestItemSchema).default([]),
    })
    .nullable(),
});

const rawContestSchema = z.object({
  title: z.string().min(1),
  titleSlug: z.string().min(1),
  startTime: z.number().finite(),
  duration: z.number().finite().nonnegative(),
  questions: z.array(rawQuestionSchema).optional().default([]),
});

const contestPayloadSchema = z.object({
  contest: rawContestSchema.nullable(),
});

const graphQLEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
      })
    )
    .optional(),
});

async function defaultContestGraphQL(
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: 'https://leetcode.com/contest/',
      Origin: 'https://leetcode.com',
      'User-Agent': DEFAULT_USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `LeetCode contest GraphQL HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(
      `LeetCode contest GraphQL returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return parsed;
}

function unwrapGraphQLData(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new Error('LeetCode contest GraphQL returned empty or non-object response.');
  }

  const envelopeCheck = graphQLEnvelopeSchema.safeParse(rawResponse);
  if (envelopeCheck.success) {
    const { data, errors } = envelopeCheck.data;
    if (errors && errors.length > 0) {
      const messages = errors
        .map((e) => e.message?.trim())
        .filter((msg): msg is string => Boolean(msg));
      throw new Error(
        `LeetCode contest GraphQL error: ${messages.join('; ') || 'unknown GraphQL error'}`
      );
    }
    if ('data' in rawResponse && data !== undefined) {
      return data;
    }
  }

  return rawResponse;
}

function contestKindFromSlug(titleSlug: string): ContestKind {
  return titleSlug.startsWith('biweekly-contest-') ? 'biweekly' : 'weekly';
}

function contestPrefixForKind(kind: ContestKind): string {
  return kind === 'biweekly' ? 'biweekly-contest-' : 'weekly-contest-';
}

function mapQuestions(
  rawQuestions: z.infer<typeof rawQuestionSchema>[]
): ContestQuestionSummary[] {
  // Strictly preserve ordered Q1..Q4 indices; never filter by credit or difficulty.
  return rawQuestions.slice(0, 4).map((q, i) => {
    const index = i as 0 | 1 | 2 | 3;
    return {
      index,
      label: CONTEST_LABELS[index],
      title: q.title,
      titleSlug: q.titleSlug,
      questionId: q.questionId,
      credit: q.credit,
    };
  });
}

function mapContestSummary(
  item: {
    title: string;
    titleSlug: string;
    startTimeSec: number;
    duration: number;
    questions: z.infer<typeof rawQuestionSchema>[];
  },
  kind?: ContestKind
): ContestSummary {
  return {
    title: item.title,
    titleSlug: item.titleSlug,
    kind: kind ?? contestKindFromSlug(item.titleSlug),
    startTimeSec: item.startTimeSec,
    endTimeSec: item.startTimeSec + item.duration,
    questions: mapQuestions(item.questions),
  };
}

export async function fetchRecentContestsByType(
  kind: ContestKind,
  limit = 5,
  options?: FetchContestsOptions
): Promise<ContestSummary[]> {
  const targetLimit = Math.floor(limit);
  if (targetLimit <= 0) {
    return [];
  }

  const graphql = options?.graphql ?? defaultContestGraphQL;
  const prefix = contestPrefixForKind(kind);
  const collected: ContestSummary[] = [];
  const seenSlugs = new Set<string>();

  pageLoop: for (let pageNo = 1; pageNo <= MAX_PAST_CONTEST_PAGES; pageNo++) {
    const raw = await graphql(PAST_CONTESTS_QUERY, {
      pageNo,
      numPerPage: DEFAULT_NUM_PER_PAGE,
    });
    const unwrapped = unwrapGraphQLData(raw);
    const parsed = pastContestsPayloadSchema.safeParse(unwrapped);
    if (!parsed.success) {
      throw new Error(
        `Invalid pastContests GraphQL payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`
      );
    }

    const pastContests = parsed.data.pastContests;
    if (!pastContests || pastContests.data.length === 0) {
      break;
    }

    for (const item of pastContests.data) {
      if (item.isVirtual) {
        continue;
      }
      if (!item.titleSlug.startsWith(prefix)) {
        continue;
      }
      if (seenSlugs.has(item.titleSlug)) {
        continue;
      }

      const startTimeSec = item.startTime ?? item.originStartTime;
      if (typeof startTimeSec !== 'number' || !Number.isFinite(startTimeSec)) {
        continue;
      }

      seenSlugs.add(item.titleSlug);
      collected.push(
        mapContestSummary(
          {
            title: item.title,
            titleSlug: item.titleSlug,
            startTimeSec,
            duration: item.duration,
            questions: item.questions,
          },
          kind
        )
      );

      if (collected.length >= targetLimit) {
        break pageLoop;
      }
    }

    if (
      typeof pastContests.pageNum === 'number' &&
      pastContests.pageNum > 0 &&
      pageNo >= pastContests.pageNum
    ) {
      break;
    }
  }

  // Right after a contest ends (e.g. 09:31 / 21:31 IST), pastContests can lag briefly
  // even though contest(titleSlug: "<prefix><N+1>") is already queryable.
  const nowSec = Math.floor((options?.now ?? new Date()).getTime() / 1000);
  const newest = collected[0];
  if (newest && newest.endTimeSec <= nowSec - 3600) {
    const suffixMatch = newest.titleSlug.slice(prefix.length).match(/^(\d+)$/);
    if (suffixMatch) {
      const nextSlug = `${prefix}${Number(suffixMatch[1]) + 1}`;
      try {
        const next = await fetchContestBySlug(nextSlug, options);
        if (next && next.endTimeSec <= nowSec && !seenSlugs.has(next.titleSlug)) {
          collected.unshift(next);
        }
      } catch {
        // Best-effort lag probe only; preserve collected pastContests items on error.
      }
    }
  }

  return collected.slice(0, targetLimit);
}

export async function fetchContestBySlug(
  contestSlug: string,
  options?: FetchContestsOptions
): Promise<ContestSummary | null> {
  const slug = contestSlug.trim();
  if (!slug) {
    return null;
  }

  const graphql = options?.graphql ?? defaultContestGraphQL;
  const raw = await graphql(CONTEST_QUERY, { titleSlug: slug });
  const unwrapped = unwrapGraphQLData(raw);
  const parsed = contestPayloadSchema.safeParse(unwrapped);

  if (!parsed.success) {
    throw new Error(
      `Invalid contest GraphQL payload for "${slug}": ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }

  const contest = parsed.data.contest;
  if (!contest) {
    return null;
  }

  return mapContestSummary({
    title: contest.title,
    titleSlug: contest.titleSlug,
    startTimeSec: contest.startTime,
    duration: contest.duration,
    questions: contest.questions,
  });
}

export async function fetchLatestEndedContest(
  kind: ContestKind,
  now: Date = new Date(),
  options?: FetchContestsOptions
): Promise<ContestSummary | null> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const recent = await fetchRecentContestsByType(kind, 10, { ...options, now });
  const ended = recent
    .filter((contest) => contest.endTimeSec <= nowSec)
    .sort((a, b) => b.endTimeSec - a.endTimeSec || b.startTimeSec - a.startTimeSec);

  return ended[0] ?? null;
}

export function selectStartingContestQuestions(
  contest: ContestSummary,
  indices: readonly (0 | 1)[] = [0, 1]
): ContestQuestionSummary[] {
  const selected: ContestQuestionSummary[] = [];
  const seen = new Set<number>();

  for (const index of indices) {
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);

    const question = contest.questions.find((q) => q.index === index);
    if (question) {
      selected.push(question);
    }
  }

  return selected;
}
