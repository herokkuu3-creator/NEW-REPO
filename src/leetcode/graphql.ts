import { Page } from 'playwright';
import { z } from 'zod';

/**
 * Minimal same-origin GraphQL client.
 *
 * Queries execute INSIDE the loaded leetcode.com page via fetch(), so the
 * browser's own session cookies apply naturally — we never read, copy, or
 * log those cookies. This is deliberately preferred over brittle DOM
 * scraping for everything LeetCode exposes through its API.
 */

export class GraphQLError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export async function leetcodeGraphQL<T>(
  page: Page,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await page.evaluate(
    async ({ query, variables }) => {
      const res = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query, variables }),
      });
      const text = await res.text();
      return { status: res.status, body: text };
    },
    { query, variables },
  );

  if (result.status !== 200) {
    throw new GraphQLError(`GraphQL HTTP ${result.status}`, result.status);
  }

  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch {
    throw new GraphQLError('GraphQL returned non-JSON body');
  }

  const errors = (json as { errors?: { message?: string }[] }).errors;
  if (errors && errors.length > 0) {
    throw new GraphQLError(`GraphQL error: ${errors[0]?.message ?? 'unknown'}`);
  }

  const data = (json as { data?: unknown }).data;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new GraphQLError(`GraphQL response failed validation: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}
