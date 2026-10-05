import type { Page } from 'playwright';
import { nativeVerificationComplete, waitForCodeforcesPage } from './browserForm';
import { VERIFICATION_LIFETIME_MS, type VerificationAction } from './verificationRelay';

export type PhoneVerification = (page: Page, mode: 'submit' | 'result' | 'turnstile') => Promise<boolean>;

/** Forward only explicit human gestures, never solver-generated interactions. */
export async function applyVerificationAction(page: Page, action: VerificationAction): Promise<boolean> {
  if (new URL(page.url()).hostname !== 'codeforces.com') return false;
  if (await nativeVerificationComplete(page)) return false;
  if (action.type === 'cancel') return false;
  if (action.type === 'scroll') {
    await page.mouse.wheel(0, action.delta);
    return true;
  }
  // A submit form may already be present. Never expose its Submit button or
  // source editor to remote gestures, avoiding accidental/duplicate POSTs.
  let allowed = false;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || !/^https:\/\/challenges\.cloudflare\.com\//.test(frame.url())) continue;
    const element = await frame.frameElement().catch(() => null);
    const box = await element?.boundingBox().catch(() => null);
    if (box && action.x >= box.x && action.x < box.x + box.width && action.y >= box.y && action.y < box.y + box.height) allowed = true;
    await element?.dispose();
  }
  if (!allowed) {
    allowed = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return !!target?.closest('.cf-turnstile, [data-sitekey]');
    }, action);
  }
  if (!allowed) return false;
  await page.mouse.click(action.x, action.y);
  return true;
}

export function createPhoneVerification(base: string, id: string, headers: Record<string, string>): PhoneVerification {
  let handoffs = 0;
  let failed = false;
  return async (page, mode) => {
    // A page-level challenge and the form widget may both appear. Allow each,
    // but cancellation/expiry stops the job instead of opening more links.
    if (failed || handoffs >= 2) return false;
    handoffs++;
    const deadline = Date.now() + VERIFICATION_LIFETIME_MS;
    let announced = false;
    let completed = false;
    try {
      while (Date.now() < deadline) {
        if (new URL(page.url()).hostname !== 'codeforces.com') return false;
        const ready = mode === 'turnstile' ? await nativeVerificationComplete(page)
          : await waitForCodeforcesPage(page, mode, 150);
        if (ready) { completed = true; return true; }
        const size = page.viewportSize();
        if (!size) return false;
        const image = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 });
        const response = await fetch(`${base}/jobs/${id}/verification`, {
          method: 'POST', headers,
          body: JSON.stringify({ image: image.toString('base64'), ...size }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return false;
        announced = true;
        const state = await response.json() as { actions: VerificationAction[] };
        for (const action of state.actions) {
          if (action.type === 'cancel') return false;
          await applyVerificationAction(page, action);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return false;
    } finally {
      failed = !completed;
      if (announced) {
        await fetch(`${base}/jobs/${id}/verification`, {
          method: 'POST', headers, body: JSON.stringify({ close: true }), signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
      }
    }
  };
}
