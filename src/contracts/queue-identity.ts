// FR-R3-110 (FR-100, FR-104) — queue *identity* lives here; queue *management*
// lives in `src/queue/`.
//
// WHY THEY ARE SEPARATE
//
// This is FR-R3-089's `backend-kinds.ts` reasoning applied to the queue, and it
// was found the same way: by asking which modules import a queue module and what
// they actually need from it.
//
// Two of the answers were across the trust boundary. `webview-ui/src/lib/
// history-rerun.ts` imported `DEFAULT_QUEUE_ID` from `src/queue/queue-registry`
// and `history-rows.ts` imported `HISTORY_UNATTRIBUTED_QUEUE_ID` from
// `src/state/history-entry` — both **runtime value** imports, so everything those
// modules transitively pull in shipped into the untrusted webview bundle to
// deliver two string literals. A third was backwards in the layering:
// `src/contracts/state-schema.ts` imported the unattributed sentinel from
// `src/state/`, so the contract layer depended on the state layer it describes.
//
// The rule the move establishes: **a module that needs to name a queue must not,
// by that fact alone, pull in the code that manages one.**
// `tests/lint/dependency-direction.test.ts` and
// `tests/lint/webview-host-import-direction.test.ts` keep it true.
//
// The old exports are DELETED rather than re-exported, which is the whole
// mechanism — the same reasoning `AGENTS.md` records for the ambient run
// accessors. A re-export leaves two import paths for one constant, the webview's
// bundle keeps whatever the old path drags in, and `npm run typecheck` stops
// being the exhaustive call-site worklist. FR-R3-089's note that "a barrel
// everything imports from is the same coupling with a different filename" applies
// to a compatibility shim too.
//
// This module imports nothing, on purpose. It is a leaf.
//
// `MAX_QUEUES` is an adjacent but separate concern and lives in
// `src/contracts/queue-bounds.ts`: it is a *capacity* bound rather than an
// identity, and it moved for a different reason — the contracts validator
// value-imported it from `src/queue/`. Kept in its own leaf so a module that needs
// to name the default queue does not acquire the cap, and vice versa.

/**
 * The queue every workspace has.
 *
 * Feature 092 made the registry multi-entry, and this id survived that as the
 * entry a fresh workspace starts with and the one a legacy single-queue state
 * migrates into. It is persisted, so it is a compatibility surface: changing the
 * literal would orphan every stored queue keyed by it.
 */
export const DEFAULT_QUEUE_ID = 'default' as const;

/**
 * The queue a history entry is attributed to when its real queue cannot be
 * determined.
 *
 * Double-underscored so it cannot collide with an operator-chosen queue id.
 * History entries written before feature 093's per-queue attribution carry this,
 * and the migrator assigns it rather than guessing a queue — a guessed
 * attribution reads as fact, while this reads as "unknown", which is what it is.
 */
export const HISTORY_UNATTRIBUTED_QUEUE_ID = '__unattributed__';
