// FR-R6-F14 T020 — what one delivery result means and when the next attempt may start: the
// status classes, partial success, response anomalies, and the bounded backoff (FR-005, FR-010,
// FR-012, FR-013; NFR-002).
import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS, type TransportResult } from '../../../src/contracts/telemetry-export';
import { classifyDelivery, nextRetry } from '../../../src/services/telemetry-export/retry-policy';
import { mulberry32 } from '../../fixtures/seeded-rng';

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function response(statusCode: number, body = '{}', extra: { retryAfterSeconds?: number | null; bodyTruncated?: boolean } = {}): TransportResult {
  return {
    kind: 'response',
    statusCode,
    retryAfterSeconds: extra.retryAfterSeconds ?? null,
    body: bytes(body),
    bodyTruncated: extra.bodyTruncated ?? false
  };
}

describe('classifyDelivery: success', () => {
  it('acknowledges a 200 with an empty object', () => {
    expect(classifyDelivery(response(200))).toEqual({ outcome: 'acknowledged', rejectedDataPoints: 0, anomaly: null });
  });

  it.each([
    ['a number', '{"partialSuccess":{"rejectedDataPoints":3,"errorMessage":"three were refused"}}', 3],
    ['decimal text', '{"partialSuccess":{"rejectedDataPoints":"41"}}', 41],
    ['zero', '{"partialSuccess":{"rejectedDataPoints":0}}', 0],
    ['an empty partial success', '{"partialSuccess":{}}', 0]
  ])('keeps the rejected count of a partial success given as %s', (_label, body, expected) => {
    expect(classifyDelivery(response(200, body))).toEqual({ outcome: 'acknowledged', rejectedDataPoints: expected, anomaly: null });
  });

  it('keeps nothing of the destination text', () => {
    const result = classifyDelivery(response(200, '{"partialSuccess":{"rejectedDataPoints":1,"errorMessage":"marker-text"}}'));
    expect(JSON.stringify(result)).not.toContain('marker-text');
  });

  it.each([
    ['an empty body', ''],
    ['text that is not JSON', 'ok'],
    ['a JSON list', '[]'],
    ['a JSON null', 'null'],
    ['a partial success that is not an object', '{"partialSuccess":7}'],
    ['a negative count', '{"partialSuccess":{"rejectedDataPoints":-1}}'],
    ['a fractional count', '{"partialSuccess":{"rejectedDataPoints":1.5}}'],
    ['a count that is not decimal text', '{"partialSuccess":{"rejectedDataPoints":"1e3"}}'],
    ['a count past the safe range', '{"partialSuccess":{"rejectedDataPoints":"99999999999999999"}}'],
    ['a count of the wrong type', '{"partialSuccess":{"rejectedDataPoints":true}}']
  ])('acknowledges %s as malformed, with no rejected count', (_label, body) => {
    expect(classifyDelivery(response(200, body))).toEqual({
      outcome: 'acknowledged',
      rejectedDataPoints: 0,
      anomaly: 'response-malformed'
    });
  });

  it('acknowledges a truncated body as oversized without reading it', () => {
    const body = '{"partialSuccess":{"rejectedDataPoints":9}}';
    expect(classifyDelivery(response(200, body, { bodyTruncated: true }))).toEqual({
      outcome: 'acknowledged',
      rejectedDataPoints: 0,
      anomaly: 'response-oversized'
    });
  });
});

describe('classifyDelivery: failure', () => {
  it.each([[429], [502], [503], [504]])('retries a %i', (statusCode) => {
    expect(classifyDelivery(response(statusCode))).toEqual({ outcome: 'retry', errorClass: 'http-retryable', retryAfterMs: null });
  });

  it.each([[429], [503]])('honours Retry-After on a %i', (statusCode) => {
    const result = classifyDelivery(response(statusCode, '', { retryAfterSeconds: 7 }));
    expect(result).toEqual({ outcome: 'retry', errorClass: 'http-retryable', retryAfterMs: 7_000 });
  });

  it.each([[502], [504]])('ignores Retry-After on a %i', (statusCode) => {
    const result = classifyDelivery(response(statusCode, '', { retryAfterSeconds: 7 }));
    expect(result).toEqual({ outcome: 'retry', errorClass: 'http-retryable', retryAfterMs: null });
  });

  it.each([['network'], ['tls'], ['deadline']] as const)('retries a %s failure under its own class', (errorClass) => {
    expect(classifyDelivery({ kind: 'failure', errorClass })).toEqual({ outcome: 'retry', errorClass, retryAfterMs: null });
  });

  it('treats an aborted request as a network failure', () => {
    expect(classifyDelivery({ kind: 'failure', errorClass: 'aborted' })).toEqual({
      outcome: 'retry',
      errorClass: 'network',
      retryAfterMs: null
    });
  });

  it.each([[400], [401], [403], [404], [408], [413], [500], [501], [505], [599]])('rejects a %i without a retry', (statusCode) => {
    expect(classifyDelivery(response(statusCode))).toEqual({ outcome: 'rejected', errorClass: 'http-rejected' });
  });

  it.each([[201], [202], [204], [100], [199], [600], [0], [-1], [200.5]])('rejects %d: only 200 is the defined success', (statusCode) => {
    expect(classifyDelivery(response(statusCode))).toEqual({ outcome: 'rejected', errorClass: 'http-rejected' });
  });

  it.each([[300], [301], [302], [303], [304], [307], [308], [399]])('refuses a %i as a redirect', (statusCode) => {
    expect(classifyDelivery(response(statusCode))).toEqual({ outcome: 'redirect-refused' });
  });
});

describe('nextRetry', () => {
  const B = TELEMETRY_EXPORT_BOUNDS;
  const first = 1_000_000;

  function ask(attemptsMade: number, random: number, overrides: { now?: number; retryAfterMs?: number | null } = {}) {
    return nextRetry({
      attemptsMade,
      firstAttemptAt: first,
      now: overrides.now ?? first,
      retryAfterMs: overrides.retryAfterMs ?? null,
      random: () => random
    });
  }

  it.each([
    [1, 500],
    [2, 1_000],
    [3, 2_000],
    [4, 4_000],
    [5, 8_000]
  ])('before retry %i the full delay is %i ms and the least is half of it', (attemptsMade, fullDelay) => {
    expect(ask(attemptsMade, 0)).toEqual({ kind: 'retry', delayMs: fullDelay / 2 });
    const top = ask(attemptsMade, 0.999999);
    expect(top.kind).toBe('retry');
    const delay = top.kind === 'retry' ? top.delayMs : Number.NaN;
    expect(delay).toBeGreaterThan(fullDelay / 2);
    expect(delay).toBeLessThanOrEqual(fullDelay);
  });

  it('keeps every delay inside [half, full] for a seeded sequence', () => {
    const rng = mulberry32(313);
    for (let sample = 0; sample < 500; sample += 1) {
      const attemptsMade = 1 + (sample % B.retriesMax);
      const full = B.retryBaseDelayMs * 2 ** (attemptsMade - 1);
      const result = nextRetry({ attemptsMade, firstAttemptAt: first, now: first, retryAfterMs: null, random: rng });
      const delay = result.kind === 'retry' ? result.delayMs : Number.NaN;
      expect(delay).toBeGreaterThanOrEqual(full / 2);
      expect(delay).toBeLessThanOrEqual(full);
    }
  });

  it('refuses a sixth retry', () => {
    expect(ask(B.retriesMax + 1, 0)).toEqual({ kind: 'exhausted' });
  });

  it('is exhausted when the delay and one more request would pass the budget', () => {
    const lastStart = first + B.retryBudgetMs - B.requestDeadlineMs;
    expect(ask(1, 1, { now: lastStart - 500 })).toEqual({ kind: 'retry', delayMs: 500 });
    expect(ask(1, 1, { now: lastStart - 499 })).toEqual({ kind: 'exhausted' });
  });

  it('lets six full attempts and five full delays fit the budget', () => {
    let now = first;
    for (let attemptsMade = 1; attemptsMade <= B.retriesMax; attemptsMade += 1) {
      now += B.requestDeadlineMs;
      const result = ask(attemptsMade, 1, { now });
      expect(result.kind).toBe('retry');
      now += result.kind === 'retry' ? result.delayMs : 0;
    }
    expect(now + B.requestDeadlineMs - first).toBe(27_500);
  });

  it('replaces the delay with a longer Retry-After and ignores a shorter one', () => {
    expect(ask(1, 1, { retryAfterMs: 3_000 })).toEqual({ kind: 'retry', delayMs: 3_000 });
    expect(ask(3, 1, { retryAfterMs: 100 })).toEqual({ kind: 'retry', delayMs: 2_000 });
  });

  it('is exhausted without waiting when Retry-After passes the budget', () => {
    expect(ask(1, 0, { retryAfterMs: B.retryBudgetMs })).toEqual({ kind: 'exhausted' });
  });

  it.each([[Number.NaN], [-1], [Number.POSITIVE_INFINITY]])('ignores a Retry-After of %d', (retryAfterMs) => {
    expect(ask(1, 1, { retryAfterMs })).toEqual({ kind: 'retry', delayMs: 500 });
  });

  it.each([[Number.NaN], [-0.5], [1.5], [Number.POSITIVE_INFINITY]])('treats a random value of %d as the full delay', (random) => {
    expect(ask(1, random)).toEqual({ kind: 'retry', delayMs: 500 });
  });
});
