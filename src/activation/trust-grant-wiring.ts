// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Subscribes to one VS Code event and forwards it. The acts it eventually causes
// belong to `stage2-producers.ts`, which is THE GATE and re-reads trust when it
// runs, so this module writes nothing, spawns nothing and arms no timer of its
// own — at wiring time or afterwards.

import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import type { Stage2Producers } from './stage2-producers';

/**
 * Run the producer half when the operator grants Workspace Trust.
 *
 * FR-R3-136 (FR-010) — the one subscriber for the one event VS Code offers;
 * `producers.run()` carries the idempotence a repeated grant needs.
 *
 * WHY THE PRODUCERS ARE FETCHED THROUGH A THUNK. A reload replaces the Stage 2
 * graph, and a grant arriving after one must reach the CURRENT producers rather
 * than a disposed lock. A thunk returning `null` means no folder is open or
 * `store.initialize()` failed, and a grant repairs neither: the next
 * `ensureStage2()` builds its own producers and reads trust as it is by then, so
 * the grant is not lost — it is not this subscription's to act on.
 *
 * WHY IT LIVES HERE AND NOT IN `extension.ts`. `FR-R3-119`'s LOC budget put the
 * composition root within 25 lines of its ceiling, and the rule it enforces is
 * that a ceiling that close is a high-water mark nobody decided on. This
 * subscription is the piece of that file with the fewest ties to the rest of it:
 * one event, one thunk, one log line.
 */
export function wireTrustGrant(input: {
  readonly logger: SanitizedLogger;
  readonly getProducers: () => Stage2Producers | null;
}): vscode.Disposable {
  const { logger, getProducers } = input;
  return vscode.workspace.onDidGrantWorkspaceTrust(() => {
    logger.info('workspace trust granted; starting stage 2 producers');
    // The rejection is caught HERE because this is the only path where nothing
    // awaits it. On the activation path `wireStage2` awaits `run()`, so a
    // landmark that throws surfaces through activation; here a bare `void` would
    // discard it into an unhandled rejection — no log line, no notification —
    // while `hasRun()` is already true, so nothing retries. The operator would be
    // left with a folder they just trusted behaving like one they had not, and no
    // record of why.
    void getProducers()
      ?.run()
      .catch((err: unknown) => {
        logger.warn(`stage 2 producers failed after trust grant: ${(err as Error).message}`);
      });
  });
}
