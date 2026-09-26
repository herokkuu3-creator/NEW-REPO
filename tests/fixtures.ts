/** Shared fake-cookie fixtures (fake tokens only, same shape as real exports). */

export function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function fakeSession(payload: Record<string, unknown>): string {
  return `${b64url({ typ: 'JWT', alg: 'HS256' })}.${b64url(payload)}.fakesignature_abcdefghij`;
}

/** A storageState shaped exactly like the capture-extension export. */
export function captureExport(session: string, cookieExpires = 1_900_000_000): string {
  return JSON.stringify({
    cookies: [
      { name: '__stripe_mid', value: 'x', domain: '.leetcode.com', path: '/', expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: 'Strict' },
      { name: 'INGRESSCOOKIE', value: 'x', domain: 'leetcode.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'csrftoken', value: 'fakecsrf123', domain: 'leetcode.com', path: '/', expires: 1_821_896_535.35, httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'messages', value: 'x', domain: 'leetcode.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'LEETCODE_SESSION', value: session, domain: '.leetcode.com', path: '/', expires: cookieExpires, httpOnly: true, secure: true, sameSite: 'Lax' },
    ],
    origins: [{ origin: 'https://leetcode.com', localStorage: [] }],
  });
}

