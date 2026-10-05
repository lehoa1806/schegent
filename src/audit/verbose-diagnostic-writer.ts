import * as path from 'path';
import { narrowMode, noticeFor, type NarrowingNotice } from '../lib/narrow-mode';
import { ensureDirWithinRoot, openWithinRoot } from '../lib/safe-open';
import type { SanitizedLogger } from '../lib/logger';
import type { VerboseDiagnosticTarget } from '../runner/invocation-result';

export type { VerboseDiagnosticTarget };

export interface VerboseDiagnosticResult {
  readonly warnings: ReadonlyArray<string>;
}

type Slot = 'directory' | 'stream' | 'verbose';

/**
 * FR-R3-050 (M-13) — owner-only, because this content is unredacted by design.
 *
 * The module header records that "the operator opted in to raw payloads." That
 * opt-in is about what gets WRITTEN. It says nothing about who may READ it, and
 * the threat model claims private modes -- while `mkdir` and `appendFile` were
 * called with no `mode` at all. Measured before this change under a 022 umask:
 * directories 0o755, files 0o644, i.e. every local account could read raw prompts
 * and raw model output.
 *
 * `mode` is a POSIX concept. On a platform that does not enforce it these values
 * are inert, which `narrowMode` reports as `unsupported` and this writer records
 * as a warning, rather than letting the file be described as private.
 */
const DIAGNOSTIC_DIR_MODE = 0o700;
const DIAGNOSTIC_FILE_MODE = 0o600;

const OCTAL_RADIX = 8;

/**
 * Best-effort sibling sink for `--debug-to-file`, `--output-format
 * stream-json`, and `--verbose` CLI streams.
 *
 * Writes appear under
 * `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`.
 * Directory creation and per-file write failures fold into a single
 * one-shot warning per slot (FR-025 / data-model.md §6). Writes are
 * unredacted — the operator opted in to raw payloads.
 */
export class VerboseDiagnosticWriter {
  private readonly logger: SanitizedLogger;
  private readonly preparedDirs = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly warnedSlots = new Map<string, Set<Slot>>();

  constructor(logger: SanitizedLogger) {
    this.logger = logger;
  }

  public async prepare(target: VerboseDiagnosticTarget): Promise<void> {
    if (this.preparedDirs.has(target.directory)) return;
    try {
      // FR-R3-053 (H-02) — walk the segments, refusing a symlink at every
      // component, instead of `mkdir -p` on a composed absolute path. The
      // composer already proved the path does not escape LEXICALLY; that says
      // nothing about what `mkdir` follows on the way there, and these
      // diagnostics are deliberately unredacted.
      //
      const ready = await ensureDirWithinRoot(
        target.workspaceRoot,
        target.segments,
        DIAGNOSTIC_DIR_MODE
      );
      if (ready.outcome === 'refused') {
        this.recordWarning(
          target,
          'directory',
          `verbose diagnostic directory refused: ${ready.reason}`
        );
        return;
      }
      // A `mode` applies only when the path is CREATED. A directory that already
      // exists -- every workspace that predates this change -- keeps whatever it
      // had, so the defect would persist for almost all installs. Tighten it.
      //
      // One-directional, deliberately: tighten a directory more permissive than
      // required, never loosen one that is already stricter. An operator (or an
      // umask) who made it 0o500 meant it, and widening that to 0o700 would be
      // this fix causing the exposure it exists to remove.
      //
      // Feature 217 (FR-007) — through the product's one narrowing routine, which
      // began life here. `ensureDirWithinRoot` creates but never narrows, so this
      // directory is narrowed by name.
      const narrowed = noticeFor(
        'directory',
        await narrowMode(target.directory, DIAGNOSTIC_DIR_MODE)
      );
      if (narrowed !== null) this.recordNarrowing(target, 'directory', narrowed);
      this.preparedDirs.add(target.directory);
    } catch (err) {
      this.recordWarning(
        target,
        'directory',
        `verbose diagnostic directory create failed (${target.directory}): ${(err as Error).message}`
      );
    }
  }

  public async teeStream(target: VerboseDiagnosticTarget, chunk: string): Promise<void> {
    await this.appendBestEffort(target, 'stream', target.streamFile, chunk);
  }

  public async teeVerbose(target: VerboseDiagnosticTarget, chunk: string): Promise<void> {
    await this.appendBestEffort(target, 'verbose', target.verboseLogFile, chunk);
  }

  public result(): VerboseDiagnosticResult {
    return { warnings: [...this.warnings] };
  }

  private async appendBestEffort(
    target: VerboseDiagnosticTarget,
    slot: Slot,
    file: string,
    chunk: string
  ): Promise<void> {
    if (chunk.length === 0) return;
    try {
      // FR-R3-053 — through the walk, not on the composed path.
      const leaf = path.basename(file);
      const opened = await openWithinRoot(target.workspaceRoot, [...target.segments, leaf], {
        flags: 'a',
        createDirs: true,
        dirMode: DIAGNOSTIC_DIR_MODE,
        fileMode: DIAGNOSTIC_FILE_MODE
      });
      if (opened.outcome === 'refused') {
        this.recordWarning(target, slot, `verbose diagnostic ${slot} refused: ${opened.reason}`);
        return;
      }
      // Same reasoning as the directory: the mode applies on creation, so a file
      // written before this change stays readable until it is tightened. The
      // exposure is identical, so the treatment is.
      //
      // Feature 217 — the open has already narrowed this file, and every
      // directory it walked through, with the modes declared above; what is left
      // here is saying so.
      for (const notice of opened.narrowing) {
        this.recordNarrowing(target, notice.scope === 'directory' ? 'directory' : slot, notice);
      }
      try {
        await opened.handle.write(chunk, null, 'utf8');
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    } catch (err) {
      this.recordWarning(
        target,
        slot,
        `verbose diagnostic ${slot} write failed (${file}): ${(err as Error).message}`
      );
    }
  }

  /**
   * Record what a narrowing did, because silently changing a permission is the
   * same class of surprise as silently leaving one open. A narrowing is an
   * informational line; a path that could not be made private is a warning,
   * so it is never described as private.
   *
   * Feature 217 — the notice is path-free: it carries an errno-shaped code, never
   * the platform's message, which can name the path.
   */
  private recordNarrowing(target: VerboseDiagnosticTarget, slot: Slot, notice: NarrowingNotice): void {
    switch (notice.outcome) {
      case 'narrowed':
        this.logger.info(
          `verbose diagnostic ${slot} mode tightened to owner-only (was ${notice.previousMode.toString(OCTAL_RADIX)})`
        );
        return;
      case 'refused-symlink':
        this.recordWarning(
          target,
          slot,
          `verbose diagnostic ${slot} mode not enforced: path is a symbolic link`
        );
        return;
      case 'unsupported':
        this.recordWarning(
          target,
          slot,
          `verbose diagnostic ${slot} mode could not be enforced: ${notice.code}`
        );
        return;
    }
  }

  private recordWarning(target: VerboseDiagnosticTarget, slot: Slot, message: string): void {
    const seen = this.warnedSlots.get(target.directory) ?? new Set<Slot>();
    if (seen.has(slot)) return;
    seen.add(slot);
    this.warnedSlots.set(target.directory, seen);
    this.warnings.push(message);
    this.logger.warn(message);
  }
}
