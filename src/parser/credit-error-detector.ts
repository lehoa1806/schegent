export const RATE_LIMIT_MATCHERS: ReadonlyArray<{ regex: RegExp; cause: string }> = Object.freeze([
  { regex: /(?:rate.?limit|too\s+many\s+requests|429)/i, cause: 'rate-limit' },
  // Feature 027 FR-014 — operator-visible "You're out of extra usage"
  // (and the "extra"-omitted variant) routes through the rate-limit
  // path so it picks up the dynamic backoff instead of the 15-minute
  // transient-error path. Anchored on "out of (extra )?usage" so
  // unrelated "out of bandwidth/space/etc." strings do NOT match.
  { regex: /out of (?:extra )?usage/i, cause: 'out-of-usage' },
  { regex: /credits?.{0,20}(exhausted|insufficient|depleted)/i, cause: 'credits-exhausted' },
  { regex: /quota.{0,20}exceeded/i, cause: 'quota-exceeded' }
]);

export interface CreditDetectionResult {
  matched: boolean;
  cause: string;
  // Feature 027 — optional parsed reset epoch (ms). `detectCreditError`
  // itself does NOT populate this field (it has access to `stderr`
  // only); callers populate it from `extractResetTimestamp(stdout)` per
  // FR-006.
  resetsAtMs?: number | null;
}

export function detectCreditError(stderr: string, exitCode: number | null): CreditDetectionResult {
  for (const { regex, cause } of RATE_LIMIT_MATCHERS) {
    if (regex.test(stderr)) {
      return { matched: true, cause };
    }
  }
  if (exitCode === 429) {
    return { matched: true, cause: 'rate-limit' };
  }
  return { matched: false, cause: '' };
}

export function detectStatusOk(stdout: string): boolean {
  if (/credit.{0,30}(available|ok|restored)/i.test(stdout)) return true;
  if (/status.{0,30}(ok|healthy|ready)/i.test(stdout)) return true;
  if (/\bquota.{0,20}(available|reset)/i.test(stdout)) return true;
  return false;
}
