import * as fs from 'fs/promises';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'path';
import * as os from 'node:os';
import type { Phase } from '../controller/phase';
import type { SanitizedLogger } from '../lib/logger';
import type { InvocationOutputSink } from '../runner/invocation-result';
import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';
import { ensureSchegentGitignore } from './schegent-gitignore';
import {
  normalizeEvidenceFailureCause,
  type EvidenceHealthReporter
} from '../services/evidence-health/evidence-health-monitor';

const SESSION_START = '========== SESSION START ==========';
const SESSION_END = '========== SESSION END ==========';
const RAW_SPOOL_PREFIX = 'schegent-raw-spool-';

export interface RawTranscriptStartInput {
  runId: string;
  phase: Phase;
  iteration: number;
  prompt: string;
}

export interface RawTranscriptEndInput {
  runId: string;
  stdout: string | ZippedStreamBuffer;
  stderr: string | ZippedStreamBuffer;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  /** Verbatim disk-backed stream capture, when one was available. */
  capture?: RawTranscriptCapture | null;
}

export interface RawTranscriptCapture extends InvocationOutputSink {
  readonly failed: boolean;
  finish(): Promise<void>;
  appendStreamTo(stream: 'stdout' | 'stderr', destination: FileHandle): Promise<void>;
  dispose(): Promise<void>;
}

class FileRawTranscriptCapture implements RawTranscriptCapture {
  private readonly streams: Record<'stdout' | 'stderr', WriteStream>;
  private finishPromise: Promise<void> | null = null;
  private disposed = false;
  private didFail = false;

  constructor(
    private readonly spoolDirectory: string,
    private readonly paths: Record<'stdout' | 'stderr', string>,
    private readonly onFailure: (err: Error) => void
  ) {
    this.streams = {
      stdout: createWriteStream(paths.stdout, { flags: 'wx', mode: 0o600 }),
      stderr: createWriteStream(paths.stderr, { flags: 'wx', mode: 0o600 })
    };
    for (const stream of Object.values(this.streams)) {
      // WriteStream errors must never escape into a subprocess data handler.
      stream.on('error', (err) => this.recordFailure(err));
    }
  }

  public get failed(): boolean {
    return this.didFail;
  }

  public write(stream: 'stdout' | 'stderr', chunk: string): boolean {
    const destination = this.streams[stream];
    if (this.finishPromise || destination.destroyed || destination.writableEnded) {
      return true;
    }
    try {
      return destination.write(chunk, 'utf8');
    } catch (err) {
      // The permanent error listener reports asynchronous failures. A
      // synchronous closed/destroyed-stream failure is still best-effort and
      // must not interrupt runner control flow.
      this.recordFailure(err as Error);
      return true;
    }
  }

  public onceDrain(stream: 'stdout' | 'stderr', callback: () => void): void {
    const source = this.streams[stream];
    if (source.destroyed || !source.writableNeedDrain) {
      queueMicrotask(callback);
      return;
    }
    let settled = false;
    const resume = (): void => {
      if (settled) return;
      settled = true;
      source.off('drain', resume);
      source.off('error', resume);
      source.off('close', resume);
      callback();
    };
    source.once('drain', resume);
    source.once('error', resume);
    source.once('close', resume);
  }

  public finish(): Promise<void> {
    this.finishPromise ??= Promise.all([
      this.finishStream(this.streams.stdout),
      this.finishStream(this.streams.stderr)
    ]).then(() => undefined);
    return this.finishPromise;
  }

  public async appendStreamTo(
    stream: 'stdout' | 'stderr',
    destination: FileHandle
  ): Promise<void> {
    await this.finish();
    if (this.failed) {
      throw new Error('raw transcript spool failed while finalizing');
    }
    try {
      for await (const chunk of createReadStream(this.paths[stream])) {
        await destination.write(chunk as Buffer);
      }
      if (this.failed) {
        throw new Error('raw transcript spool failed while being copied');
      }
    } catch (err) {
      this.recordFailure(err as Error);
      throw err;
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.finish();
    await fs.rm(this.spoolDirectory, { recursive: true, force: true });
  }

  private finishStream(stream: WriteStream): Promise<void> {
    if (stream.closed) return Promise.resolve();
    return new Promise((resolve) => {
      stream.once('close', resolve);
      if (!stream.writableEnded && !stream.destroyed) stream.end();
    });
  }

  private recordFailure(err: Error): void {
    this.didFail = true;
    this.onFailure(err);
  }
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
  private gitignoreEnsure: Promise<void> | null = null;
  private spoolScavenge: Promise<void> | null = null;
  private emptyRunIdWarned = false;

  constructor(
    workspaceRoot: string,
    logger: SanitizedLogger,
    private readonly spoolRoot: string = os.tmpdir(),
    private readonly evidenceHealth?: EvidenceHealthReporter
  ) {
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

  /**
   * Creates a bounded-memory, disk-backed tee for one CLI invocation. The
   * returned sink applies WriteStream backpressure and is finalized by
   * `appendEnd`. Returns `null` on I/O failure so callers can retain the
   * legacy bounded-buffer fallback without failing the workflow.
   */
  public async createInvocationCapture(runId: string): Promise<RawTranscriptCapture | null> {
    if (!runId) {
      this.warnEmptyRunId();
      return null;
    }
    let spoolDirectory: string | null = null;
    try {
      await this.ensureRuntimeGitignore();
      await this.ensureSpoolRoot();
      // Spools contain unredacted bytes. Keep them in the OS-managed temp
      // area rather than the workspace so an extension-host crash cannot
      // strand hidden sensitive directories under `.schegent/sessions`.
      spoolDirectory = await fs.mkdtemp(
        path.join(this.spoolRoot, `${RAW_SPOOL_PREFIX}${process.pid}-`)
      );
      await fs.chmod(spoolDirectory, 0o700);
      return new FileRawTranscriptCapture(
        spoolDirectory,
        {
          stdout: path.join(spoolDirectory, 'stdout'),
          stderr: path.join(spoolDirectory, 'stderr')
        },
        (err) => this.warnStreamFailure(runId, err)
      );
    } catch (err) {
      if (spoolDirectory) {
        try {
          await fs.rm(spoolDirectory, { recursive: true, force: true });
        } catch {
          this.warnCleanupFailure();
        }
      }
      this.warnWriteFailure(runId, err as Error);
      return null;
    }
  }

  public async appendEnd(input: RawTranscriptEndInput): Promise<void> {
    if (!input.runId) {
      await input.capture?.dispose();
      this.warnEmptyRunId();
      return;
    }
    const previous = this.chains.get(input.runId) ?? Promise.resolve();
    const next = previous.then(() => this.doWriteEnd(input));
    this.chains.set(input.runId, next);
    return next;
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
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await this.ensureRuntimeGitignore();
      await fs.appendFile(target, content, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.warnWriteFailure(runId, err as Error);
    }
  }

  private async doWriteEnd(input: RawTranscriptEndInput): Promise<void> {
    const target = this.filePathFor(input.runId);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await this.ensureRuntimeGitignore();

      const handle = await fs.open(target, 'a', 0o600);
      try {
        await handle.write('[STDOUT]\n');
        const stdoutComplete = await appendCapturedOrBuffered(handle, input.capture, 'stdout', input.stdout);
        await handle.write('\n\n[STDERR]\n');
        const stderrComplete = await appendCapturedOrBuffered(handle, input.capture, 'stderr', input.stderr);
        await handle.write(`\n\n[EXIT_CODE]: ${formatExitCode(input)}\n${SESSION_END}\n\n`);
        if (!stdoutComplete || !stderrComplete) {
          const error = Object.assign(new Error('capture fallback used'), { code: 'partial-write' });
          this.warnWriteFailure(input.runId, error);
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      this.warnWriteFailure(input.runId, err as Error);
    } finally {
      try {
        await input.capture?.dispose();
      } catch {
        this.warnCleanupFailure();
      }
    }
  }

  private warnWriteFailure(runId: string, err: Error): void {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    const shouldWarn = this.evidenceHealth?.reportFailure(
      'rawTranscript',
      normalizeEvidenceFailureCause(code)
    ) ?? !this.failedRuns.has(runId);
    if (!shouldWarn) return;
    this.failedRuns.add(runId);
    this.logger.warn(`raw transcript write failed for run ${runId}; workflow continues with degraded raw evidence`, {
      ...(typeof (err as NodeJS.ErrnoException).code === 'string'
        ? { errno: (err as NodeJS.ErrnoException).code }
        : {})
    });
  }

  private warnStreamFailure(runId: string, err: Error): void {
    const code = (err as NodeJS.ErrnoException).code;
    const preservedCause = code === 'ENOSPC' || code === 'EACCES' ||
      code === 'EPERM' || code === 'EROFS';
    this.warnWriteFailure(
      runId,
      preservedCause
        ? err
        : Object.assign(new Error('raw transcript stream failed'), {
            code: 'stream-error'
          })
    );
  }

  private warnCleanupFailure(): void {
    const shouldWarn = this.evidenceHealth?.reportFailure(
      'rawTranscript',
      'cleanup-failed'
    ) ?? true;
    if (shouldWarn) {
      this.logger.warn(
        'raw transcript spool cleanup failed; workflow continues with degraded raw evidence'
      );
    }
  }

  private ensureRuntimeGitignore(): Promise<void> {
    this.gitignoreEnsure ??= ensureSchegentGitignore(this.workspaceRoot, this.logger);
    return this.gitignoreEnsure;
  }

  private ensureSpoolRoot(): Promise<void> {
    this.spoolScavenge ??= scavengeAbandonedSpools(this.spoolRoot).catch(() => {
      this.warnCleanupFailure();
    });
    return this.spoolScavenge;
  }

  private warnEmptyRunId(): void {
    if (this.emptyRunIdWarned) return;
    this.emptyRunIdWarned = true;
    this.logger.warn('raw transcript skipped: empty runId');
  }
}

async function scavengeAbandonedSpools(spoolRoot: string): Promise<void> {
  await fs.mkdir(spoolRoot, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(spoolRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^schegent-raw-spool-(\d+)-/);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;
    await fs.rm(path.join(spoolRoot, entry.name), { recursive: true, force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'EINVAL';
  }
}

async function writeBufferedOutput(
  destination: FileHandle,
  output: string | ZippedStreamBuffer
): Promise<void> {
  if (typeof output === 'string') {
    await destination.write(output);
    return;
  }
  for (const chunk of output.decompressStream()) {
    await destination.write(chunk);
  }
}

async function appendCapturedOrBuffered(
  destination: FileHandle,
  capture: RawTranscriptCapture | null | undefined,
  stream: 'stdout' | 'stderr',
  buffered: string | ZippedStreamBuffer
): Promise<boolean> {
  if (!capture || capture.failed) {
    await writeBufferedOutput(destination, buffered);
    return capture?.failed !== true;
  }
  const startOffset = (await destination.stat()).size;
  try {
    await capture.appendStreamTo(stream, destination);
    if (capture.failed) {
      throw new Error('raw transcript capture became incomplete while being copied');
    }
    return true;
  } catch {
    // The capture may have copied a prefix before its read failed. Rewind that
    // partial copy, then preserve the bounded head/tail fallback instead.
    await destination.truncate(startOffset);
    await writeBufferedOutput(destination, buffered);
    return false;
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

function formatExitCode(input: RawTranscriptEndInput): string {
  if (input.timedOut) return 'timeout';
  if (input.exitCode === null) return 'null';
  return String(input.exitCode);
}
