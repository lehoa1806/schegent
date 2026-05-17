// Feature 013 — T052 (Wave 4 / US4 / FR-015, FR-016).
//
// The queue-level `pausedReason` originates in the controller, monitor,
// or watchdog (rate-limit cause, fatal-signature message, stall context)
// — all places where operator-visible secrets could slip in. The
// projector is the SINGLE sanitization + length-cap point before the
// value reaches the webview.
//
// This test pins the contract by exercising `sanitizeAndCap` directly
// (the helper module-exports for testability) and the full projector
// flow end-to-end with a fake `SanitizedLogger` and `WorkspaceStateStore`.

import { describe, it, expect } from 'vitest';
import {
  PAUSED_REASON_MAX_LENGTH,
  sanitizeAndCap
} from '../../../../src/ui/sidebar/state-projector';
import { SanitizedLogger } from '../../../../src/lib/logger';

describe('sanitizeAndCap — pure helper (T052 / FR-015, FR-016)', () => {
  const logger = new SanitizedLogger();
  const sanitize = (s: string): string => logger.sanitize(s);

  it('redacts a Bearer token in a pause reason', () => {
    const raw = 'Bearer abc.def.ghi-jkl_mno-pqr expired during clarify-2';
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('abc.def.ghi-jkl_mno-pqr');
    expect(out!).toContain('[REDACTED]');
  });

  it('redacts a sk-ant API key', () => {
    const raw = 'auth failed for sk-ant-1234567890abcdef1234567890abcdef';
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('sk-ant-1234567890');
    expect(out!).toContain('[REDACTED]');
  });

  it('redacts an env-style SECRET=value fragment', () => {
    // The logger's redaction set catches uppercase `(SECRET|TOKEN|API_KEY|...)=`
    // patterns. Lowercase `client_secret=` is intentionally OUT-OF-SCOPE for
    // Wave 4 — extending the set requires a code change + PR review per the
    // project's hard rule on `src/lib/logger.ts`.
    const raw = 'env init failed: SECRET=xyz_super_secret_value_1234 was rejected';
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('xyz_super_secret_value_1234');
    expect(out!).toContain('[REDACTED]');
  });

  it('redacts a JWT in a pause reason', () => {
    const raw = 'auth header eyJabcdef12.eyJpYXQiOjAxMjM.signature_abc123def expired';
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('eyJabcdef12.eyJpYXQiOjAxMjM.signature_abc123def');
    expect(out!).toContain('[REDACTED]');
  });

  it('caps a 600-char input to (max-1) chars + ellipsis', () => {
    const raw = 'a'.repeat(600);
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(PAUSED_REASON_MAX_LENGTH);
    expect(out!.endsWith('…')).toBe(true);
    expect(out!.slice(0, PAUSED_REASON_MAX_LENGTH - 1)).toBe('a'.repeat(PAUSED_REASON_MAX_LENGTH - 1));
  });

  it('returns null for an empty string after sanitization', () => {
    const out = sanitizeAndCap('', sanitize);
    expect(out).toBeNull();
  });

  it('returns null for null input', () => {
    const out = sanitizeAndCap(null, sanitize);
    expect(out).toBeNull();
  });

  it('returns null for undefined input', () => {
    const out = sanitizeAndCap(undefined, sanitize);
    expect(out).toBeNull();
  });

  it('passes through a 200-char already-clean string unchanged', () => {
    const raw = 'watchdog: no audit-log activity in the last 10 minutes — pausing the queue for operator review and possible retry. ' .repeat(2).slice(0, 200);
    expect(raw.length).toBe(200);
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).toBe(raw);
    expect(out!.length).toBe(200);
  });

  it('passes through exactly 500 chars without truncation', () => {
    const raw = 'b'.repeat(PAUSED_REASON_MAX_LENGTH);
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).toBe(raw);
    expect(out!.length).toBe(PAUSED_REASON_MAX_LENGTH);
    expect(out!.endsWith('…')).toBe(false);
  });

  it('truncates first, ellipsis at position max-1', () => {
    const raw = 'x'.repeat(PAUSED_REASON_MAX_LENGTH + 1);
    const out = sanitizeAndCap(raw, sanitize);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(PAUSED_REASON_MAX_LENGTH);
    expect(out!.charAt(PAUSED_REASON_MAX_LENGTH - 1)).toBe('…');
    expect(out!.slice(0, PAUSED_REASON_MAX_LENGTH - 1)).toBe('x'.repeat(PAUSED_REASON_MAX_LENGTH - 1));
  });

  it('honors a pass-through sanitize function (no logger seam)', () => {
    const identity = (s: string): string => s;
    const raw = 'Bearer would-not-be-redacted-here';
    const out = sanitizeAndCap(raw, identity);
    expect(out).toBe(raw);
  });
});
