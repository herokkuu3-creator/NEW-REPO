/** GitHub Actions entry point. Job inputs contain only an opaque id. */
import { BrowserFormError } from './browserForm';
import { submit } from './submitterService';

async function main(): Promise<void> {
  const base = process.env.CODEFORCES_SUBMITTER_URL?.replace(/\/+$/, '');
  const token = process.env.CODEFORCES_SUBMITTER_TOKEN;
  const id = process.env.CODEFORCES_JOB_ID;
  if (!base || !token || !id) throw new Error('runner job configuration is incomplete');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const claim = await fetch(`${base}/jobs/${id}/claim`, { method: 'POST', headers, signal: AbortSignal.timeout(30_000) });
  if (!claim.ok) throw new Error(`could not claim browser job (HTTP ${claim.status})`);
  const request = await claim.json() as Parameters<typeof submit>[0];
  let result: Awaited<ReturnType<typeof submit>>;
  try {
    result = await submit(request);
  } catch (err) {
    const formError = err instanceof BrowserFormError ? err : null;
    result = {
      ok: false,
      kind: formError?.kind ?? 'submission-error',
      error: err instanceof Error ? err.message : String(err),
      status: null,
      finalUrl: '',
      clicked: formError?.clicked ?? false,
      turnstile: formError?.flags.turnstile ?? false,
      interactive: formError?.flags.interactive ?? false,
    };
  }
  // The POST to Codeforces is never retried. Only delivery of its result may
  // be retried after a transport failure, and the broker accepts it once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}/jobs/${id}/result`, {
        method: 'POST', headers, body: JSON.stringify(result), signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        process.stdout.write(`Browser job completed: ok=${result.ok}, clicked=${result.clicked}, status=${result.status ?? '?'}\n`);
        return;
      }
    } catch { /* Retry result delivery, never the Codeforces form. */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('browser result could not be delivered to Render');
}

void main().catch((err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; });
