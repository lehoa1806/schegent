export type SchegentErrorCode =
  | 'cli-not-found'
  | 'scaffolding-missing'
  | 'lock-held'
  | 'phase-timeout'
  | 'audit-malformed'
  | 'audit-evidence-unavailable'
  | 'rate-limited'
  | 'invocation-failed'
  | 'invalid-state'
  | 'cancelled';

export class SchegentError extends Error {
  public readonly code: SchegentErrorCode;
  public readonly phase: string | null;
  public readonly iteration: number | null;

  constructor(
    code: SchegentErrorCode,
    message: string,
    options: { phase?: string | null; iteration?: number | null; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'SchegentError';
    this.code = code;
    this.phase = options.phase ?? null;
    this.iteration = options.iteration ?? null;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class CliNotFoundError extends SchegentError {
  constructor(binary: string) {
    super('cli-not-found', `Claude CLI binary not found: ${binary}`);
    this.name = 'CliNotFoundError';
  }
}

export class ScaffoldingMissingError extends SchegentError {
  constructor(reason: string) {
    super('scaffolding-missing', `Speckit scaffolding missing: ${reason}`);
    this.name = 'ScaffoldingMissingError';
  }
}

export class LockHeldError extends SchegentError {
  public readonly ownerId: string;
  constructor(ownerId: string) {
    super('lock-held', `Workspace lock held by another window`);
    this.name = 'LockHeldError';
    this.ownerId = ownerId;
  }
}

export class PhaseTimeoutError extends SchegentError {
  constructor(phase: string, iteration: number, timeoutMs: number) {
    super('phase-timeout', `Phase ${phase} exceeded timeout (${timeoutMs}ms)`, { phase, iteration });
    this.name = 'PhaseTimeoutError';
  }
}

export class AuditMalformedError extends SchegentError {
  public readonly missingFields: string[];
  constructor(missingFields: string[]) {
    super('audit-malformed', `Audit log block malformed: missing ${missingFields.join(', ')}`);
    this.name = 'AuditMalformedError';
    this.missingFields = missingFields;
  }
}

/**
 * A required structured-audit event could not be durably recorded.
 *
 * The event type is safe operational metadata. The underlying filesystem
 * error is deliberately not retained here so this exception cannot carry a
 * workspace path or other sensitive sink detail across process boundaries.
 */
export class RequiredEvidenceUnavailableError extends SchegentError {
  public readonly eventType: string;

  constructor(eventType: string) {
    super(
      'audit-evidence-unavailable',
      `Required structured audit evidence is unavailable (${eventType})`
    );
    this.name = 'RequiredEvidenceUnavailableError';
    this.eventType = eventType;
  }
}

export class RateLimitedError extends SchegentError {
  public readonly cause: string;
  constructor(causeLabel: string) {
    super('rate-limited', `Rate-limited or credits exhausted: ${causeLabel}`);
    this.name = 'RateLimitedError';
    this.cause = causeLabel;
  }
}

export class InvocationFailedError extends SchegentError {
  public readonly exitCode: number | null;
  constructor(exitCode: number | null, summary: string) {
    super('invocation-failed', `CLI invocation failed (exit=${exitCode ?? 'killed'}): ${summary}`);
    this.name = 'InvocationFailedError';
    this.exitCode = exitCode;
  }
}

/**
 * FR-R3-110 (FR-107) — the message of anything that was thrown.
 *
 * WHAT IT REPLACES. `(err as Error).message` appears at 151 sites in `src/`. The cast is a lie
 * the compiler is told to accept: `catch` binds `unknown`, and JavaScript permits throwing
 * anything. `throw 'boom'` — which a dependency, a JSON parse of a rejected value, or a
 * `Promise.reject('reason')` can all produce — makes that expression evaluate to `undefined`,
 * and the log line becomes `phase failed: undefined`. The compiler cannot flag it, because the
 * cast is precisely an instruction not to check.
 *
 * That failure mode is not hypothetical for this product: every one of those 151 sites is on an
 * error path, which is where diagnostics matter most and where they are least exercised.
 *
 * WHAT IT DOES. Returns a non-empty string for every input. An `Error` gives its message; a
 * string gives itself; anything else is described rather than interpolated, because
 * `String({})` is `[object Object]` and tells a reader nothing. An empty message is reported as
 * the error's constructor name, since `Error` with no message is a real and unhelpful case.
 *
 * WHAT IT IS NOT. Not a sanitizer. Callers that write to an operator-visible sink still pass the
 * result through `logger.sanitize()`; `SECRET_PATTERNS` remains the single authority on
 * redaction and this function does not fork it.
 */
export function errorMessage(thrown: unknown): string {
  if (thrown instanceof Error) {
    const message = thrown.message.trim();
    return message.length > 0 ? message : `${thrown.name || 'Error'} (no message)`;
  }
  if (typeof thrown === 'string') {
    const trimmed = thrown.trim();
    return trimmed.length > 0 ? trimmed : 'empty string thrown';
  }
  if (thrown === null) return 'null thrown';
  if (thrown === undefined) return 'undefined thrown';
  if (typeof thrown === 'object') {
    // A plain object's `message`, if it has a usable one — a rejected value from a library that
    // does not use `Error` is the common shape here. Otherwise DESCRIBE it: `String({})` is
    // `[object Object]`, which is worse than saying nothing because it looks like content.
    const candidate = (thrown as { message?: unknown }).message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    // The constructor is read through `unknown` rather than optional-chained: TypeScript types
    // `constructor` as always present, so `?.` reads as dead code to the linter — but an object
    // created with `Object.create(null)` genuinely has none, and this branch exists for values a
    // library threw.
    const ctor: unknown = (thrown as { constructor?: unknown }).constructor;
    const ctorName = typeof ctor === 'function' ? ctor.name : undefined;
    return `non-Error object thrown (${ctorName ?? 'unknown type'})`;
  }
  // number, boolean, bigint, symbol, function — all safely stringifiable and all worth naming.
  return `${typeof thrown} thrown: ${String(thrown)}`;
}
