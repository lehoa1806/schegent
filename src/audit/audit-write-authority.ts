// FR-R4-F03 (FR-010, FR-012; R10) — who may write the audit log, asked at the step that writes.
//
// THE PROBLEM IT CLOSES. The audit writer is constructed in every window, because a non-owner
// window still reads and verifies through it. Nothing stopped a secondary window from appending:
// its rows interleaved with the owner's and forked the chain at the first transfer. Asking once at
// `append()` is not enough either, because a step queued before ownership was lost runs later, so
// the question is asked INSIDE every write step and every maintenance step, immediately before a
// file is touched.
//
// A PORT, NOT THE LOCK. The writer takes `{ currentFence() }` and nothing else, so it never learns
// how ownership is decided and `repo/src/state/lock.ts` (hard rule 4) is not edited. The production
// adapter below reads the workspace lock; tests drive the writer through adapters over a shared
// mutable cell, which is how two "windows" are modelled without two real ones.
import type { WorkspaceLockManager } from '../state/lock';

/** The question the writer asks before every step that writes. */
export interface AuditWriteAuthority {
  /** The fence this window holds now, or null when it is not the owner. Never throws. */
  currentFence(): Promise<number | null>;
}

/**
 * Raised, and noticed, when a write or maintenance step is refused because this window is not the
 * owner. The message names the event type and says where the action belongs, and names no path
 * (FR-019, hard rule 22).
 */
export class AuditNotOwnerError extends Error {
  public readonly code = 'audit-not-owner';

  public constructor(public readonly eventType: string | null) {
    super(
      eventType === null
        ? 'audit write refused: only the owner window records audit evidence; run the action in ' +
            'the owner window'
        : `audit write refused for ${eventType}: only the owner window records audit evidence; ` +
            'run the action in the owner window'
    );
    this.name = 'AuditNotOwnerError';
  }
}

/**
 * The production adapter: the fence of record while this window holds primacy, otherwise `null`.
 *
 * FAILS CLOSED, like `isWindowPrimary`. A throw from the lock, and a `null` fence while primary,
 * both answer `null`, so an unanswerable question is never read as "yes, write".
 */
export function lockWriteAuthority(
  lock: Pick<WorkspaceLockManager, 'hasPrimacy' | 'fenceOfRecord'>
): AuditWriteAuthority {
  return {
    async currentFence(): Promise<number | null> {
      try {
        if (!(await lock.hasPrimacy())) return null;
        return lock.fenceOfRecord();
      } catch {
        return null;
      }
    }
  };
}

/**
 * The authority a writer uses when none is supplied: always the owner, with a constant fence.
 *
 * Many existing tests build a writer with no lock at all and expect it to write. Production wiring
 * always supplies a real authority (`evidence-wiring.ts`), and a test pins that it does.
 */
export const OWNER_FOR_TESTS: AuditWriteAuthority = Object.freeze({
  currentFence: (): Promise<number | null> => Promise.resolve(0)
});
