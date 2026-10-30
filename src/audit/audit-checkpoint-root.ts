// FR-R4-F03 (FR-015; contract C1; R13) — the anchor directory of the head checkpoint store, and nothing else.
//
// WHY THIS IS A MODULE OF ONE CALL. `openWithinRoot` bounds every path beneath a root it TRUSTS, and it
// never creates that root, because the root is the one path it does not verify. The checkpoint store's
// root is the extension's per-user storage (`context.globalStorageUri.fsPath`), which the extension is
// expected to create, so the one raw `mkdir` of the feature lives here, in the shape
// `run-checkpoint-service.ts` uses for its own root (`recursive: true`, `0o700`). Everything BENEATH
// the root, the `audit-checkpoints` directory and the files in it, goes through the checked walk in
// `audit-checkpoint-store.ts`.
//
// WHY IT IS SEPARATE FROM THE STORE. `tests/lint/safe-open-migration.test.ts` admits a module to either
// the trust-anchor list, whose only raw call is the anchor `mkdir`, or to the atomic-publish list, whose
// only raw call is the publish `rename`, never both. The store needs the second, so the anchor needs a
// module of its own.
import * as fs from 'fs/promises';

/**
 * Create the per-user storage root if it is missing, owner-only. Resolves when the root exists.
 * Never touches anything beneath it.
 */
export async function ensureCheckpointRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
}
