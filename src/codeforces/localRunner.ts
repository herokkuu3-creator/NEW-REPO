/** Local PC browser runner. It polls Render over HTTPS; no inbound port is needed. */
import { BrowserFormError } from './browserForm';
import { submit } from './submitterService';

const base = process.env.CODEFORCES_SUBMITTER_URL?.replace(/\/+$/, '');
const token = process.env.CODEFORCES_LOCAL_RUNNER_TOKEN?.trim();
const pollMs = Math.max(1_000, Number(process.env.CODEFORCES_LOCAL_RUNNER_POLL_MS ?? 3_000));

if (!base || !token) throw new Error('CODEFORCES_SUBMITTER_URL and CODEFORCES_LOCAL_RUNNER_TOKEN are required');

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function deliver(id: string, result: Awaited<ReturnType<typeof submit>>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}/jobs/${id}/result`, {
        method: 'POST', headers, body: JSON.stringify(result), signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return;
    } catch { /* Never repeat a form POST; only delivery of its result is retried. */ }
    await sleep(2_000);
  }
  throw new Error(`result for browser job ${id} could not be delivered to Render`);
}

async function run(id: string): Promise<void> {
  const claim = await fetch(`${base}/jobs/${id}/claim`, { method: 'POST', headers, signal: AbortSignal.timeout(30_000) });
  if (claim.status === 404) return;
  if (!claim.ok) throw new Error(`could not claim browser job ${id} (HTTP ${claim.status})`);
  const request = await claim.json() as Parameters<typeof submit>[0];
  let result: Awaited<ReturnType<typeof submit>>;
  try {
    result = await submit(request);
  } catch (err) {
    const form = err instanceof BrowserFormError ? err : null;
    result = {
      ok: false,
      kind: form?.kind ?? 'submission-error',
      error: err instanceof Error ? err.message : String(err),
      status: null,
      finalUrl: '',
      clicked: form?.clicked ?? false,
      turnstile: form?.flags.turnstile ?? false,
      interactive: form?.flags.interactive ?? false,
    };
  }
  await deliver(id, result);
  process.stdout.write(`Local Codeforces browser job completed: ${JSON.stringify({ ok: result.ok, kind: result.kind ?? null, status: result.status, clicked: result.clicked })}\n`);
}

async function loop(): Promise<void> {
  process.stdout.write(`Local Codeforces runner connected to ${base}; waiting for jobs.\n`);
  for (;;) {
    try {
      const response = await fetch(`${base}/jobs/next`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`job lookup failed (HTTP ${response.status})`);
      const body = await response.json() as { jobId?: unknown };
      if (typeof body.jobId === 'string') await run(body.jobId);
    } catch (err) {
      process.stderr.write(`Local runner: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await sleep(pollMs);
  }
}

void loop();
