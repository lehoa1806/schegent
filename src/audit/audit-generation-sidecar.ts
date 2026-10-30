// FR-R4-F04 (FR-016, FR-017, contract A2, A3; data-model §7) — remembering when a generation was first seen.
//
// The live audit log's age is measured from its oldest usable row (`audit-generation-age.ts`). That is
// enough while rows carry timestamps, but a generation can hold none a reader can use (a hand-edited or
// truncated file, rows with a malformed field), and after a restart nothing in memory says how long such a
// generation has been alive. So the writer records the time it FIRST SAW a generation in a small sidecar,
// `.schegent/audit-generation.json`, keyed by the generation's identity (the hash of its first line):
//
//   { "version": 1, "generation": "<sha256 hex of the first line's bytes>", "firstObservedAt": "<ISO>" }
//
// It is written at most once per generation, never under an `audit.log*` name (the chain and retention
// walk that prefix, and a sidecar there would be read as an archive), and `0600` through the checked walk.
// An unreadable, unparseable, unknown-version or mismatched sidecar means "not yet observed", and the
// writer records now: that can only make a generation with no usable timestamp look younger, which is
// the one case the sidecar governs. A sidecar failure never fails or delays an append: it is reported
// once and the in-memory value is used (A3).
//
// `AuditGenerationClock` holds the start for the live generation so the writer holds one field: `observe`
// (one bounded read of the live log per generation, the sidecar, the cache), `landed` (lowers the cache
// when a row's timestamp is usable and older) and `rotated` (clears it).

import { openWithinRoot } from '../lib/safe-open';
import { generationIdentity, generationStart } from './audit-generation-age';

/** The sidecar's name, beside the log and never one of its archives. */
export const AUDIT_GENERATION_SIDECAR_NAME = 'audit-generation.json';

const SCHEGENT_DIR_NAME = '.schegent';
const AUDIT_LOG_NAME = 'audit.log';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SIDECAR_VERSION = 1;
/** Far above the sidecar's own size (one short JSON object); a larger file is not one this module wrote. */
const SIDECAR_MAX_BYTES = 4096;

export interface AuditGenerationSidecar {
  readonly version: 1;
  readonly generation: string;
  readonly firstObservedAt: string;
}

/** The sidecar, or `null` when it is absent, unreadable, unparseable, or of a version this build does not know. */
export async function readAuditGenerationSidecar(workspaceRoot: string): Promise<AuditGenerationSidecar | null> {
  const opened = await openWithinRoot(workspaceRoot, [SCHEGENT_DIR_NAME, AUDIT_GENERATION_SIDECAR_NAME], { flags: 'r' });
  if (opened.outcome === 'refused') return null;
  try {
    if ((await opened.handle.stat()).size > SIDECAR_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(await opened.handle.readFile({ encoding: 'utf8' }));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== SIDECAR_VERSION) return null;
    if (typeof candidate.generation !== 'string' || typeof candidate.firstObservedAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(candidate.firstObservedAt))) return null;
    return { version: SIDECAR_VERSION, generation: candidate.generation, firstObservedAt: candidate.firstObservedAt };
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Write the sidecar, owner-only, through the checked walk. A failure is returned, never thrown. */
export async function writeAuditGenerationSidecar(
  workspaceRoot: string,
  value: AuditGenerationSidecar
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  const opened = await openWithinRoot(workspaceRoot, [SCHEGENT_DIR_NAME, AUDIT_GENERATION_SIDECAR_NAME], {
    flags: 'w',
    createDirs: true,
    dirMode: DIR_MODE,
    fileMode: FILE_MODE
  });
  if (opened.outcome === 'refused') return { ok: false, code: opened.reason };
  try {
    await opened.handle.write(`${JSON.stringify(value)}\n`, null, 'utf8');
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, code: typeof code === 'string' ? code : 'write-failed' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export interface AuditGenerationClockDeps {
  readonly workspaceRoot: string;
  /** Said once per distinct code, path-free; the writer sends it to the runtime log. */
  readonly report: (code: string) => void;
  readonly now?: () => number;
}

/** Reads and records when the live audit generation was first observed, in the sidecar beside the log. */
export class AuditGenerationClock {
  private start: number | null = null;
  private readonly reported = new Set<string>();

  constructor(private readonly deps: AuditGenerationClockDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private report(code: string): void {
    if (this.reported.has(code)) return;
    this.reported.add(code);
    this.deps.report(code);
  }

  /**
   * The live generation's start. The first call of a generation reads the live log once, parses each
   * row's timestamp, reads or writes the sidecar, and caches the answer; later calls return the cache.
   * An empty or missing log has no generation yet and answers `now` without caching, so a generation
   * is not pinned to a start before any row exists.
   */
  async observe(): Promise<number> {
    if (this.start !== null) return this.start;
    const now = this.now();
    const content = await this.readLiveLog();
    if (content === null || content.length === 0) return now;

    const lines = content.split('\n').filter((line) => line.length > 0);
    const first = lines[0] ?? '';
    const identity = generationIdentity(Buffer.from(first, 'utf8'));
    let firstObservedAt = now;
    const sidecar = await readAuditGenerationSidecar(this.deps.workspaceRoot);
    if (sidecar !== null && sidecar.generation === identity) {
      firstObservedAt = Date.parse(sidecar.firstObservedAt);
    } else {
      const written = await writeAuditGenerationSidecar(this.deps.workspaceRoot, {
        version: SIDECAR_VERSION,
        generation: identity,
        firstObservedAt: new Date(now).toISOString()
      });
      if (!written.ok) this.report(`sidecar-write-failed:${written.code}`);
    }
    this.start = generationStart(lines.map(timestampOf), firstObservedAt);
    return this.start;
  }

  /** Lower the cached start when a landed row's timestamp is usable and older. A later one changes nothing. */
  landed(timestamp: string): void {
    if (this.start === null) return;
    const at = Date.parse(timestamp);
    if (Number.isFinite(at) && at < this.start) this.start = at;
  }

  /** The generation rotated away: the next one starts from its own first row. */
  rotated(): void {
    this.start = null;
  }

  /** One bounded read of the live log: at most the size threshold, through the checked walk. */
  private async readLiveLog(): Promise<string | null> {
    const opened = await openWithinRoot(this.deps.workspaceRoot, [SCHEGENT_DIR_NAME, AUDIT_LOG_NAME], { flags: 'r' });
    if (opened.outcome === 'refused') return null;
    try {
      return await opened.handle.readFile({ encoding: 'utf8' });
    } catch {
      this.report('live-log-unreadable');
      return null;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
}

/** A row's `timestamp`, or `''` when the line does not parse or carries none. */
function timestampOf(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line);
    const stamp = typeof parsed === 'object' && parsed !== null ? (parsed as { timestamp?: unknown }).timestamp : undefined;
    return typeof stamp === 'string' ? stamp : '';
  } catch {
    return '';
  }
}
