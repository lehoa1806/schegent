import type { SanitizedLogger } from './logger';

/** The best-effort side effects whose failures the SQLite cutover wiring reports. */
export type SideEffectOperation =
  | 'handoff-and-lane-settlement'
  | 'lane-settlement'
  | 'acp-observation-ledger'
  | 'usage-accounting'
  | 'sweep-protection-query'
  | 'acp-authorization-receipt';

export type SideEffectFailureReport = (operation: SideEffectOperation, thrown: unknown) => void;

/**
 * Review gap GC-05 (2026-11-12) — reports a failed best-effort side effect without interrupting
 * the work it rides on. One warning per operation for the life of the reporter, carrying the error
 * class and never the message: these paths fire per agent event, and a thrown message can hold a
 * path or a token.
 */
export function createSideEffectFailureReporter(
  logger: Pick<SanitizedLogger, 'warn'>
): SideEffectFailureReport {
  const reported = new Set<SideEffectOperation>();
  return (operation, thrown) => {
    if (reported.has(operation)) return;
    reported.add(operation);
    logger.warn('best-effort side effect failed; later failures of this operation are not logged', {
      operation,
      error: thrown instanceof Error ? thrown.name : typeof thrown
    });
  };
}
