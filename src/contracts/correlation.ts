import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_FIELD = 'correlationId' as const;
export const CORRELATION_ID_LENGTH = 36;

export function newCorrelationId(): string {
  return randomUUID();
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}
