// FR-R4-F01 (spec 239, US4, T058, FR-019, contract V3 G9 and G10, constitution principle I) — an
// unknown-provenance Run is disclosed once, and nothing waits for the operator.
//
// A Run frozen with a verdict basis this version cannot date keeps the policy the runtime already
// applies. Telling the operator is a notification they can ignore: no button, no awaited answer, no
// pause, no audit event. The migrated Runs are an information line in the log and no notification.

import { describe, expect, it, vi } from 'vitest';
import { discloseVerdictBasisMigration } from '../../../src/activation/evidence-wiring';
import type { VerdictBasisMigrationEvent } from '../../../src/state/host-verification-migrator';

const RUN_ID = '0123456789abcdef-the-rest-of-a-uuid';
const UNKNOWN: VerdictBasisMigrationEvent = {
  type: 'verdict-basis-provenance-unknown',
  runId: RUN_ID,
  queueId: 'queue-alpha',
  phaseCount: 2
};
const MIGRATED: VerdictBasisMigrationEvent = {
  type: 'verdict-basis-migrated',
  runId: RUN_ID,
  queueId: 'queue-beta',
  legacyAuthored: 1,
  legacyDefault: 3
};

function harness() {
  // A notifier whose promise never settles: the real one resolves when the operator dismisses the
  // notice, and the disclosure must not be waiting on that.
  const warn = vi.fn((..._args: unknown[]) => new Promise<never>(() => undefined));
  const logger = { warn: vi.fn(), info: vi.fn() };
  const append = vi.fn();
  return { notifier: { warn }, logger, append };
}

describe('one notification per unknown-provenance Run (G9)', () => {
  it('shows the contract text verbatim, with no buttons, and does not wait for an answer', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration([UNKNOWN], { notifier: notifier as never, logger: logger as never });

    expect(notifier.warn).toHaveBeenCalledTimes(1);
    expect(notifier.warn.mock.calls[0]).toEqual([
      'Schegent: the Run on queue queue-alpha (01234567) was frozen with a verdict basis this ' +
        'version cannot date. It keeps the current policy: Phases with side effects are judged on ' +
        'their exit status. To run it under a plan frozen now, cancel it and start it again.'
    ]);
  });

  it('writes one metadata-only warn line per event: the queue, 8 characters of the Run id, a count', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration([UNKNOWN], { notifier: notifier as never, logger: logger as never });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('verdict basis provenance unknown', {
      queueId: 'queue-alpha',
      runId: '01234567',
      phaseCount: 2
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(RUN_ID);
  });

  it('logs a journalled Run, which has no queue, without notifying the operator', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration(
      [{ ...UNKNOWN, queueId: null }],
      { notifier: notifier as never, logger: logger as never }
    );

    expect(notifier.warn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('verdict basis provenance unknown', {
      queueId: null,
      runId: '01234567',
      phaseCount: 2
    });
  });
});

describe('a migrated Run is an information line and nothing more (G10)', () => {
  it('logs one info line with the counts and shows no notification', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration([MIGRATED], { notifier: notifier as never, logger: logger as never });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('verdict basis migrated', {
      queueId: 'queue-beta',
      runId: '01234567',
      legacyAuthored: 1,
      legacyDefault: 3
    });
    expect(notifier.warn).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('handles a mixed batch: one notification, one warn, one info', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration([MIGRATED, UNKNOWN], {
      notifier: notifier as never,
      logger: logger as never
    });

    expect(notifier.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an empty batch', () => {
    const { notifier, logger } = harness();

    discloseVerdictBasisMigration([], { notifier: notifier as never, logger: logger as never });

    expect(notifier.warn).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
