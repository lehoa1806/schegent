import * as fs from 'fs/promises';
import type { SanitizedLogger } from '../lib/logger';
import type { VerboseDiagnosticTarget } from '../runner/invocation-result';

export type { VerboseDiagnosticTarget };

export interface VerboseDiagnosticResult {
  readonly warnings: ReadonlyArray<string>;
}

type Slot = 'directory' | 'stream' | 'verbose';

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
      await fs.mkdir(target.directory, { recursive: true });
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
      await fs.appendFile(file, chunk, 'utf8');
    } catch (err) {
      this.recordWarning(
        target,
        slot,
        `verbose diagnostic ${slot} write failed (${file}): ${(err as Error).message}`
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
