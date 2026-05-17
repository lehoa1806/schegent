import * as fs from 'fs/promises';
import * as path from 'path';
import type { Phase } from '../controller/phase';
import type { SanitizedLogger } from '../lib/logger';

const SESSION_START = '========== SESSION START ==========';
const SESSION_END = '========== SESSION END ==========';

export interface RawTranscriptStartInput {
  runId: string;
  phase: Phase;
  iteration: number;
  prompt: string;
}

export interface RawTranscriptEndInput {
  runId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
}

/**
 * Per-run, append-only raw text transcript of every LLM invocation.
 *
 * Writes verbatim prompt/stdout/stderr/exit-code to
 * `<workspaceRoot>/.schegent/sessions/raw-<runId>.log`. Best-effort: I/O
 * failures are caught, surfaced once per runId via the structured logger,
 * and never propagated. Intentionally unredacted — see
 * specs/008-raw-transcript-logging/spec.md (FR-008/FR-009/FR-010) for the
 * security contract.
 */
export class RawTranscriptWriter {
  private readonly workspaceRoot: string;
  private readonly logger: SanitizedLogger;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly failedRuns = new Set<string>();
  private emptyRunIdWarned = false;

  constructor(workspaceRoot: string, logger: SanitizedLogger) {
    this.workspaceRoot = workspaceRoot;
    this.logger = logger;
  }

  public async appendStart(input: RawTranscriptStartInput): Promise<void> {
    if (!input.runId) {
      this.warnEmptyRunId();
      return;
    }
    const block = formatStartBlock(input);
    await this.enqueue(input.runId, block);
  }

  public async appendEnd(input: RawTranscriptEndInput): Promise<void> {
    if (!input.runId) {
      this.warnEmptyRunId();
      return;
    }
    const block = formatEndBlock(input);
    await this.enqueue(input.runId, block);
  }

  private filePathFor(runId: string): string {
    return path.join(this.workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
  }

  private enqueue(runId: string, content: string): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.doWrite(runId, content));
    this.chains.set(runId, next);
    return next;
  }

  private async doWrite(runId: string, content: string): Promise<void> {
    const target = this.filePathFor(runId);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, content, 'utf8');
    } catch (err) {
      if (!this.failedRuns.has(runId)) {
        this.failedRuns.add(runId);
        this.logger.warn(
          `raw transcript write failed for run ${runId}: ${(err as Error).message}`
        );
      }
    }
  }

  private warnEmptyRunId(): void {
    if (this.emptyRunIdWarned) return;
    this.emptyRunIdWarned = true;
    this.logger.warn('raw transcript skipped: empty runId');
  }
}

function formatStartBlock(input: RawTranscriptStartInput): string {
  const timestamp = new Date().toISOString();
  return [
    SESSION_START,
    `Run ID: ${input.runId}`,
    `Phase: ${input.phase}`,
    `Iteration: ${input.iteration}`,
    `Timestamp: ${timestamp}`,
    '',
    '[PROMPT]',
    input.prompt,
    ''
  ].join('\n');
}

function formatEndBlock(input: RawTranscriptEndInput): string {
  return [
    '[STDOUT]',
    input.stdout,
    '',
    '[STDERR]',
    input.stderr,
    '',
    `[EXIT_CODE]: ${formatExitCode(input)}`,
    SESSION_END,
    '',
    ''
  ].join('\n');
}

function formatExitCode(input: RawTranscriptEndInput): string {
  if (input.timedOut) return 'timeout';
  if (input.exitCode === null) return 'null';
  return String(input.exitCode);
}
