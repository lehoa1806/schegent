/**
 * FR-R5-F19 (feature 278, T19.1, FR-003 to FR-005) — open the decision record of a queue row.
 *
 * WHAT IT DOES. Resolves a row to its Run's feature directory, opens `<workspaceRoot>/<featureDir>/
 * decisions.md` through the root-bounded safe open, reads it within `DECISION_RECORD_MAX_BYTES` and hands
 * the text to a read-only presenter. The answer is one of nine closed outcomes and carries no path and
 * no record text.
 *
 * THE FEATURE DIRECTORY IS UNTRUSTED TEXT. It comes from a persisted Run, so it is split into segments
 * and refused as `outside-root` when it is empty, absolute, a drive path or holds a `.`, `..`, empty or
 * NUL segment. The safe open then refuses any symlink along the way. Nothing the webview sent reaches
 * a filesystem call: the request names a row and nothing else.
 *
 * WHAT IT NEVER DOES. It never writes, never starts a process, and never hands the record text to a
 * backend prompt (FR-004): the text goes to the presenter and nowhere else. A log line carries an
 * operation and an error code, never a path, a row id or text.
 */
import type { FileHandle } from 'node:fs/promises';
import {
  DECISION_RECORD_FILE,
  DECISION_RECORD_MAX_BYTES,
  type DecisionRecordOutcome
} from '../../contracts/decision-record';
import { openWithinRoot, type SafeOpenRefusal } from '../../lib/safe-open';
import { historyErrorCode } from '../history/error-code';

/** What the row lookup knows. `featureDir: null` is a row whose Run is not held. */
export type RowFeatureDir =
  | { readonly found: false }
  | { readonly found: true; readonly featureDir: string | null };

export interface DecisionRecordOpenerDeps {
  readonly workspaceRoot: string;
  readonly isTrusted: () => boolean;
  /** Synchronous, in-memory: the row's Run's feature directory as persisted. */
  readonly featureDirOfRow: (rowId: string) => RowFeatureDir;
  /** Shows `text` read-only. A throw is an `unreadable` answer. */
  readonly present: (text: string) => Promise<void>;
  /** Reads up to `maxBytes + 1` bytes, so a body over the limit is seen as over. */
  readonly readBytes?: (handle: FileHandle, maxBytes: number) => Promise<Buffer>;
  readonly logger: { warn(message: string): void };
}

export interface DecisionRecordOpener {
  /** Never throws. */
  open(rowId: string): Promise<{ readonly outcome: DecisionRecordOutcome }>;
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;
const NUL_CHARACTER = '\u0000';

async function readUpToLimit(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
  return buffer.subarray(0, bytesRead);
}

/** The path segments of a feature directory, or `null` when it is not a plain relative path. */
export function featureDirSegments(featureDir: string): readonly string[] | null {
  if (featureDir.length === 0) return null;
  if (featureDir.includes('\\') || featureDir.includes(NUL_CHARACTER)) return null;
  if (WINDOWS_DRIVE_PREFIX.test(featureDir)) return null;
  const segments = featureDir.split('/');
  const plain = segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  return plain ? segments : null;
}

// The three symlink-shaped refusals read the same to the operator. The Windows reparse-point leaf is only
// refused where `safe-open.ts` can see it; the limit that it cannot always be seen, and why no native
// binding closes it, is settled in `docs/architecture/native-binding-decision.md`.
function outcomeOfRefusal(reason: SafeOpenRefusal, errno: string): DecisionRecordOutcome {
  switch (reason) {
    case 'symlink-component':
    case 'symlink-leaf':
    case 'reparse-point-leaf':
      return 'symlink-refused';
    case 'escapes-root':
      return 'outside-root';
    case 'not-a-regular-file':
      return 'not-a-file';
    case 'not-a-directory':
      return 'no-record';
    case 'io-failed':
      return errno === 'ENOENT' || errno === 'ENOTDIR' ? 'no-record' : 'unreadable';
    default:
      return 'unreadable';
  }
}

export function createDecisionRecordOpener(deps: DecisionRecordOpenerDeps): DecisionRecordOpener {
  const readBytes = deps.readBytes ?? readUpToLimit;

  function warn(operation: string, error: unknown): void {
    try {
      deps.logger.warn(`decision-record: open failed (operation=${operation}, errorCode=${historyErrorCode(error)})`);
    } catch {
      // A sink that throws must not turn a read-only request into a rejection.
    }
  }

  async function readAndPresent(segments: readonly string[]): Promise<DecisionRecordOutcome> {
    const opened = await openWithinRoot(deps.workspaceRoot, [...segments, DECISION_RECORD_FILE], { flags: 'r' });
    if (opened.outcome === 'refused') return outcomeOfRefusal(opened.reason, opened.errno);
    const handle = opened.handle;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return 'not-a-file';
      if (stat.size > DECISION_RECORD_MAX_BYTES) return 'too-large';
      const bytes = await readBytes(handle, DECISION_RECORD_MAX_BYTES);
      if (bytes.length > DECISION_RECORD_MAX_BYTES) return 'too-large';
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return 'unreadable';
      }
      // Trust is read again at the last moment: it can be withdrawn while the file is being read.
      if (!deps.isTrusted()) return 'workspace-not-trusted';
      try {
        await deps.present(text);
      } catch (error) {
        warn('present', error);
        return 'unreadable';
      }
      return 'opened';
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    async open(rowId: string): Promise<{ readonly outcome: DecisionRecordOutcome }> {
      try {
        if (!deps.isTrusted()) return { outcome: 'workspace-not-trusted' };
        const row = deps.featureDirOfRow(rowId);
        if (!row.found) return { outcome: 'row-not-found' };
        if (row.featureDir === null) return { outcome: 'no-record' };
        const segments = featureDirSegments(row.featureDir);
        if (segments === null) return { outcome: 'outside-root' };
        return { outcome: await readAndPresent(segments) };
      } catch (error) {
        warn('open', error);
        return { outcome: 'unreadable' };
      }
    }
  };
}
