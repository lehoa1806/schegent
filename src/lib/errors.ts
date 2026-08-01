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
