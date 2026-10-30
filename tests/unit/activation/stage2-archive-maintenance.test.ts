import { describe, expect, it } from 'vitest';

import { createStage2Producers } from '../../../src/activation/stage2-producers';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R4-F03 (FR-014; contract T8; R12) — archive maintenance runs once, after trust, in the window
 * that won the election.
 *
 * The audit writer used to prune archives, narrow their modes and write cut records from its
 * constructor, before any trust check and before the election. Maintenance is now one explicit call,
 * `auditWriter.runArchiveMaintenance()`, made from the trust gate's election-gated block. These rows
 * count that call over the same stub seam `stage2-producers-trust.test.ts` uses, so the claim is about
 * the calls this module makes and not about a filesystem the fixture might not look in.
 *
 * NON-VACUITY. "Never called" is also what a broken fixture produces, so each negative row has a
 * positive twin in the same file that runs the same fixture and requires exactly one call.
 */

interface Harness {
  readonly deps: Parameters<typeof createStage2Producers>[0];
  readonly maintenance: { calls: number };
  trusted: boolean;
}

function harness(options: { trusted: boolean; acquired?: boolean; holdReplay?: Promise<void> }): Harness {
  const maintenance = { calls: 0 };
  const state = { trusted: options.trusted };
  const logger = new SanitizedLogger([{ appendLine: () => undefined }]);
  const nothing = async (): Promise<void> => undefined;

  const deps = {
    isWorkspaceTrusted: () => state.trusted,
    logger,
    store: { getRunMap: () => ({}) },
    auditWriter: {
      append: nothing,
      runArchiveMaintenance: async () => {
        maintenance.calls += 1;
        return 'ran' as const;
      }
    },
    lock: { tryAcquire: async () => ({ acquired: options.acquired ?? true, ownerId: 'window-a' }) },
    controller: {
      resumeExistingFromActivation: nothing,
      scheduleAutoDrain: () => undefined
    },
    watchdog: { reattachOnActivation: nothing },
    scheduledStartCoordinator: { reArm: nothing },
    replayEvidenceBacklog: async () => {
      await options.holdReplay;
    },
    runSafety: { replayTerminalTransitions: nothing, sweepCheckpointRetention: nothing },
    backendCapabilities: { scan: nothing },
    startMountProbe: () => undefined,
    refreshCatalog: nothing
  } as unknown as Parameters<typeof createStage2Producers>[0];

  return {
    deps,
    maintenance,
    get trusted() {
      return state.trusted;
    },
    set trusted(next: boolean) {
      state.trusted = next;
    }
  };
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 8; round += 1) await Promise.resolve();
};

describe('stage 2 runs archive maintenance once, after trust, in the owner', () => {
  it('runs no maintenance while the workspace is untrusted', async () => {
    const h = harness({ trusted: false });
    await createStage2Producers(h.deps).run();
    await flush();
    expect(h.maintenance.calls).toBe(0);
  });

  it('runs maintenance exactly once at a trusted startup that won the election', async () => {
    const h = harness({ trusted: true, acquired: true });
    await createStage2Producers(h.deps).run();
    await flush();
    expect(h.maintenance.calls).toBe(1);
  });

  it('runs no maintenance at a trusted startup that lost the election', async () => {
    const h = harness({ trusted: true, acquired: false });
    const producers = createStage2Producers(h.deps);
    await producers.run();
    await flush();
    expect(h.maintenance.calls).toBe(0);
    // A later gain installs recovery; it is not a maintenance trigger (R12).
    await producers.installRecovery({ acquired: true, ownerId: 'window-a' });
    await flush();
    expect(h.maintenance.calls).toBe(0);
  });

  it('runs maintenance once on a grant after an untrusted activation', async () => {
    const h = harness({ trusted: false });
    const producers = createStage2Producers(h.deps);
    await producers.run();
    expect(h.maintenance.calls).toBe(0);

    h.trusted = true;
    await producers.run();
    await flush();
    expect(h.maintenance.calls).toBe(1);
  });

  it('still runs it once across two grants, and across a grant that lands during a run', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ trusted: true, acquired: true, holdReplay: held });
    const producers = createStage2Producers(h.deps);

    const first = producers.run();
    await flush();
    const second = producers.run();
    const third = producers.run();
    release();
    await Promise.all([first, second, third]);
    await producers.run();
    await flush();

    expect(h.maintenance.calls).toBe(1);
  });

  it('logs a failed maintenance once and carries on to the recovery installers', async () => {
    const h = harness({ trusted: true, acquired: true });
    const failing = {
      ...h.deps.auditWriter,
      runArchiveMaintenance: async () => {
        throw new Error('disk refused');
      }
    };
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]);
    let drained = 0;
    const deps = {
      ...h.deps,
      logger,
      auditWriter: failing,
      controller: { ...h.deps.controller, scheduleAutoDrain: () => (drained += 1) }
    } as unknown as Parameters<typeof createStage2Producers>[0];

    await createStage2Producers(deps).run();
    await flush();

    expect(drained).toBe(1);
    expect(lines.filter((line) => line.includes('archive maintenance failed'))).toHaveLength(1);
  });
});
