// FR-R4-F03 (FR-015, FR-018, FR-019; contract C2, C3; R13) — the head checkpoint store: one small file per
// workspace location, in the extension's per-user storage, read and written through the checked walk.
//
// WHERE IT LIVES AND WHY. `<root>/audit-checkpoints/<key>.json`, where `root` is
// `context.globalStorageUri.fsPath` and `key` is `checkpointKey(realpath(workspace))`. That storage
// outlives the workspace's `.schegent/`, which is the point: the case loss detection exists for is the
// removal of that directory. The key is a hash, so neither the file name nor its content carries any part
// of the workspace path (FR-019). The file holds a digest, a count, times and states only.
//
// HOW IT IS WRITTEN. A temp file `.<key>.json.<pid>.<n>.tmp` opened `wx` through the walk (owner-only
// modes, the directory created `0700`), then published by `rename` after a containment proof. A crash
// between the two leaves the old file or the new one and never a torn one. The shape is
// `state/ownership-fs.ts`'s `replace`. A symlinked `audit-checkpoints` directory is refused by the walk, on
// read and on write.
//
// WHAT IT REFUSES. A write after a read that was unreadable (R15): an unreadable file may be a newer
// release's, and overwriting it would destroy it. The writer turns the refusal into mode `off`.
//
// THIS MODULE'S ONE RAW CALL is the publish `rename`, so it sits on the atomic-publish list of
// `tests/lint/safe-open-migration.test.ts`; the anchor `mkdir` of the root is in `audit-checkpoint-root.ts`.
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveContainedLink } from '../lib/path-containment';
import { openWithinRoot } from '../lib/safe-open';
import {
  CheckpointNotWritableError,
  parseCheckpoint,
  type AuditCheckpointPort,
  type AuditHeadCheckpointV1,
  type CheckpointRead
} from './audit-checkpoint';

const CHECKPOINT_DIR = 'audit-checkpoints';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The store for one workspace location. `root` is the per-user storage root (created by
 * `ensureCheckpointRoot`), `key` the workspace's `checkpointKey`.
 */
export function createAuditCheckpointStore(options: {
  readonly root: string;
  readonly key: string;
}): AuditCheckpointPort {
  const { root, key } = options;
  const fileName = `${key}.json`;
  let tempCounter = 0;
  /** Whether the last read could not be read. A write is refused while this holds. */
  let lastReadUnreadable = false;

  const settle = (result: CheckpointRead): CheckpointRead => {
    lastReadUnreadable = result.status === 'unreadable';
    return result;
  };

  return {
    key,
    async read(): Promise<CheckpointRead> {
      const opened = await openWithinRoot(root, [CHECKPOINT_DIR, fileName], { flags: 'r' });
      if (opened.outcome === 'refused') {
        // A missing file or directory is the one ordinary refusal: nothing has been written yet.
        if (opened.reason === 'io-failed' && opened.errno === 'ENOENT') return settle({ status: 'absent' });
        return settle({ status: 'unreadable', reason: 'unreachable' });
      }
      let text: string;
      try {
        text = await opened.handle.readFile('utf8');
      } catch {
        return settle({ status: 'unreadable', reason: 'unreachable' });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      return settle(parseCheckpoint(text, key));
    },

    async write(next: AuditHeadCheckpointV1, options?: { readonly force?: boolean }): Promise<void> {
      if (lastReadUnreadable && options?.force !== true) throw new CheckpointNotWritableError();
      tempCounter += 1;
      const tempName = `.${fileName}.${process.pid}.${tempCounter}.tmp`;
      const opened = await openWithinRoot(root, [CHECKPOINT_DIR, tempName], {
        flags: 'wx',
        createDirs: true,
        dirMode: DIR_MODE,
        fileMode: FILE_MODE
      });
      if (opened.outcome === 'refused') {
        throw new Error(`audit checkpoint refused: ${opened.reason} (${opened.errno})`);
      }
      try {
        await opened.handle.writeFile(JSON.stringify(next), { encoding: 'utf8' });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      const tempPath = path.join(root, CHECKPOINT_DIR, tempName);
      const finalPath = path.join(root, CHECKPOINT_DIR, fileName);
      // Both ends, link form, before the publish: a refusal says so instead of reading as a rename
      // failure, and the temp file is removed rather than left behind.
      const proven = await Promise.all([
        resolveContainedLink(tempPath, [root]),
        resolveContainedLink(finalPath, [root])
      ]);
      const refused = proven.find((verdict) => verdict.outcome === 'refused');
      if (refused !== undefined) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw new Error('audit checkpoint refused: the publish path escapes its root');
      }
      try {
        await fs.rename(tempPath, finalPath);
        lastReadUnreadable = false;
      } catch (err) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw err;
      }
    }
  };
}
