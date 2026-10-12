import { expect, it } from 'vitest';
import { submissionLogSummary } from '../src/codeforces/submissionLog';

it('retains outcome evidence while omitting credential-bearing fields', () => {
  const summary = submissionLogSummary({
    ok: true, status: 200, clicked: true, turnstile: true, interactive: false,
    finalUrl: 'https://example.test/history?session=PRIVATE_QUERY',
    error: 'proxy http://user:PRIVATE_PASSWORD@example.test',
    updatedCookies: [{ name: 'session', value: 'PRIVATE_COOKIE' }],
  });
  expect(summary).toMatchObject({ ok: true, status: 200, clicked: true, turnstile: true, updatedCookieCount: 1 });
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_|updatedCookies|finalUrl/);
});
