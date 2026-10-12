/** Public diagnostics must never contain browser credentials or proxy passwords. */
export function submissionLogSummary(result: {
  ok: boolean;
  kind?: string;
  error?: string;
  status: number | null;
  finalUrl: string;
  clicked: boolean;
  turnstile: boolean;
  interactive: boolean;
  updatedCookies?: unknown[];
}) {
  return {
    ok: result.ok,
    kind: result.kind,
    status: result.status,
    clicked: result.clicked,
    turnstile: result.turnstile,
    interactive: result.interactive,
    updatedCookieCount: result.updatedCookies?.length ?? 0,
  };
}
