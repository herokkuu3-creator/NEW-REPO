import { describe, expect, it } from 'vitest';
import { Page } from 'playwright';
import {
  chooseLanguageOption,
  findCsrfField,
  hasSubmitForm,
  openSubmitForm,
  planProblemField,
  submitFormCandidates,
  SubmitField,
} from '../src/codeforces/submission';
import { formatCodeforcesOutcomeLine } from '../src/codeforces/report';
import { SourceIndexEntry } from '../src/codeforces/sourceRepo';

// A page double never clears a challenge, so keep the grace period to a tick.
process.env.CODEFORCES_CHALLENGE_WAIT_MS = '50';

const source = { contestId: 1, problemIndex: 'A', gym: false } as SourceIndexEntry;

const FORM_FIELDS: SubmitField[] = [
  { name: 'csrf_token', tag: 'input', type: 'hidden' },
  { name: 'submittedProblemIndex', tag: 'select', type: '' },
  { name: 'programTypeId', tag: 'select', type: '' },
  { name: 'source', tag: 'textarea', type: '' },
];

interface Route {
  status?: number;
  fields?: SubmitField[];
  body?: string;
  title?: string;
  finalPath?: string;
}

/** Minimal Page stand-in: openSubmitForm only uses goto/url/title/evaluate/locator. */
function fakePage(routes: Record<string, Route>): Page {
  let current = '';
  const at = () => routes[current] ?? {};
  const page = {
    goto: async (url: string) => {
      const path = url.replace('https://codeforces.com', '');
      if (!(path in routes)) throw new Error(`unexpected navigation to ${path}`);
      current = routes[path]!.finalPath ?? path;
      return { status: () => routes[path]!.status ?? 200 };
    },
    url: () => `https://codeforces.com${current}`,
    title: async () => at().title ?? 'Codeforces',
    evaluate: async () => at().fields ?? [],
    locator: () => ({ innerText: async () => at().body ?? '' }),
  };
  return page as unknown as Page;
}

describe('submitFormCandidates', () => {
  it('tries contest, then problemset paths for a normal problem', () => {
    expect(submitFormCandidates(source)).toEqual([
      '/contest/1/submit',
      '/problemset/submit/1/A',
      '/problemset/submit?contestId=1&problemIndex=A',
    ]);
  });

  it('uses the gym path for gym problems', () => {
    expect(submitFormCandidates({ contestId: 101021, problemIndex: '1', gym: true })).toEqual(['/gym/101021/submit']);
  });

  it('returns nothing without a contest id', () => {
    expect(submitFormCandidates({ contestId: undefined, problemIndex: 'A', gym: false })).toEqual([]);
  });
});

describe('openSubmitForm', () => {
  it('falls through a 403 to the endpoint that actually serves the form', async () => {
    const page = fakePage({
      '/contest/1/submit': { status: 403, body: 'Forbidden' },
      '/problemset/submit/1/A': { fields: FORM_FIELDS },
    });
    await expect(openSubmitForm(page, source)).resolves.toBeUndefined();
  });

  it('reports every endpoint it tried when none serves a form', async () => {
    const page = fakePage({
      '/contest/1/submit': { status: 403, body: 'Forbidden' },
      '/problemset/submit/1/A': { fields: [{ name: 'foo', tag: 'input', type: 'text' }], title: 'Codeforces' },
      '/problemset/submit?contestId=1&problemIndex=A': { status: 403, body: 'Forbidden' },
    });
    await expect(openSubmitForm(page, source)).rejects.toThrow(
      /submit form could not be opened for 1\/A.*HTTP 403.*no submit form.*foo/s,
    );
  });

  it('stops as signed out when redirected to the login page', async () => {
    const page = fakePage({ '/contest/1/submit': { finalPath: '/enter', body: 'Login' } });
    await expect(openSubmitForm(page, source)).rejects.toThrow(/signed out/i);
  });

  it('stops on a bot verification page instead of trying to fill it', async () => {
    const page = fakePage({ '/contest/1/submit': { body: 'Just a moment... checking your browser' } });
    await expect(openSubmitForm(page, source)).rejects.toThrow(/verification page/i);
  });
});

describe('form field planning', () => {
  it('detects a full submit form', () => {
    expect(hasSubmitForm(FORM_FIELDS)).toBe(true);
    expect(hasSubmitForm([{ name: 'source', tag: 'textarea', type: '' }])).toBe(false);
  });

  it('finds the csrf field whatever it is named', () => {
    expect(findCsrfField(FORM_FIELDS)).toBe('csrf_token');
    expect(findCsrfField([{ name: 'X-Csrf-Token', tag: 'input', type: 'hidden' }])).toBe('X-Csrf-Token');
    expect(findCsrfField([{ name: 'foo', tag: 'input', type: 'text' }])).toBeNull();
  });

  it('picks the problem selector variant the page actually uses', () => {
    expect(planProblemField(FORM_FIELDS)).toBe('select-index');
    expect(planProblemField([{ name: 'submittedProblemIndex', tag: 'input', type: 'hidden' }])).toBe('input-index');
    expect(planProblemField([{ name: 'submittedProblemCode', tag: 'input', type: 'text' }])).toBe('input-code');
    expect(planProblemField([{ name: 'other', tag: 'input', type: 'text' }])).toBe('none');
  });

  it('prefers the newest GNU G++ and PyPy 3', () => {
    const options = [
      { value: '54', text: 'GNU G++17' },
      { value: '89', text: 'GNU G++23' },
      { value: '91', text: 'Python 3' },
      { value: '90', text: 'PyPy 3' },
    ];
    expect(chooseLanguageOption(options, 'cpp')?.value).toBe('89');
    expect(chooseLanguageOption(options, 'python')?.value).toBe('90');
    expect(chooseLanguageOption([{ value: '4', text: 'Microsoft Visual C++' }], 'cpp')?.value).toBe('4');
    expect(chooseLanguageOption([{ value: '1', text: 'GNU GCC' }], 'python')).toBeNull();
  });
});

describe('failure reporting', () => {
  it('shows the underlying error when there is no real verdict', () => {
    const line = formatCodeforcesOutcomeLine({
      label: 'me_superman',
      username: 'me_superman',
      kind: 'failed',
      problem: '1A — Theatre Square',
      verdict: null,
      error: 'Codeforces submit form could not be opened (HTTP 403)',
    });
    expect(line).toContain('HTTP 403');
    expect(line).not.toContain('SUBMISSION-ERROR');
  });

  it('shows the verdict when one exists', () => {
    const line = formatCodeforcesOutcomeLine({
      label: 'me_superman',
      kind: 'failed',
      problem: '1A — Theatre Square',
      verdict: 'WRONG_ANSWER',
      error: 'Codeforces verdict: WRONG_ANSWER',
    });
    expect(line).toContain('WRONG_ANSWER');
  });
});
