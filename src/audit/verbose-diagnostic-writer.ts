import * as fs from 'fs/promises';
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
 * are inert, which `recordModeLimitation` states rather than letting the file be
 * described as private.
 */
const DIAGNOSTIC_DIR_MODE = 0o700;
const DIAGNOSTIC_FILE_MODE = 0o600;

/** Bits that must never be set on a diagnostic path: group and other, all classes. */
const NON_OWNER_BITS = 0o077;

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
      await fs.mkdir(target.directory, { recursive: true, mode: DIAGNOSTIC_DIR_MODE });
      // A `mode` applies only when the path is CREATED. A directory that already
      // exists -- every workspace that predates this change -- keeps whatever it
      // had, so the defect would persist for almost all installs. Tighten it.
      //
      // One-directional, deliberately: tighten a directory more permissive than
      // required, never loosen one that is already stricter. An operator (or an
      // umask) who made it 0o500 meant it, and widening that to 0o700 would be
      // this fix causing the exposure it exists to remove.
      await this.tightenIfPermissive(target, 'directory', target.directory, DIAGNOSTIC_DIR_MODE);
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
      await fs.appendFile(file, chunk, { encoding: 'utf8', mode: DIAGNOSTIC_FILE_MODE });
      // Same reasoning as the directory: the mode applies on creation, so a file
      // written before this change stays readable until it is tightened. The
      // exposure is identical, so the treatment is.
      await this.tightenIfPermissive(target, slot, file, DIAGNOSTIC_FILE_MODE);
    } catch (err) {
      this.recordWarning(
        target,
        slot,
        `verbose diagnostic ${slot} write failed (${file}): ${(err as Error).message}`
      );
    }
  }

  /**
   * Narrow a path's mode to `desired` if it currently grants anything outside the
   * owner. Never widens. Records what it did, because silently changing a
   * permission is the same class of surprise as silently leaving one open.
   *
   * A platform that cannot report or enforce modes lands in the catch, which
   * records the limitation rather than letting the caller believe the path is
   * private.
   */
  private async tightenIfPermissive(
    target: VerboseDiagnosticTarget,
    slot: Slot,
    pathname: string,
    desired: number
  ): Promise<void> {
    try {
      // `lstat`, not `stat`, and refuse a symlink outright. `stat` reports the
      // TARGET's mode and `chmod` changes the TARGET (POSIX has no `lchmod` on
      // Linux, and Node follows the link), so on a path an attacker can plant a
      // symlink into this would become a chmod-an-arbitrary-file primitive.
      // Bounded -- the mask only ever clears bits, so the worst case is stripping
      // access from a file someone else owns the name of, not granting any -- but
      // the diagnostics directory is inside the workspace, and refusing costs
      // nothing: a real diagnostic path is never a symlink.
      const stat = await fs.lstat(pathname);
      if (stat.isSymbolicLink()) {
        this.recordWarning(
          target,
          slot,
          `verbose diagnostic ${slot} mode not enforced: path is a symbolic link`
        );
        return;
      }
      const current = stat.mode & 0o777;
      if ((current & NON_OWNER_BITS) === 0) return;
      await fs.chmod(pathname, current & desired);
      this.logger.info(
        `verbose diagnostic ${slot} mode tightened to owner-only (was ${current.toString(8)})`
      );
    } catch (err) {
      this.recordWarning(
        target,
        slot,
        `verbose diagnostic ${slot} mode could not be enforced: ${(err as Error).message}`
      );
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
