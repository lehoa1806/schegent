import * as fs from 'fs/promises';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'path';
import * as os from 'node:os';
import type { Phase } from '../controller/phase';
import type { RawTranscriptMode, WorkflowRunStatus } from '../state/workflow-run';
import type { SanitizedLogger } from '../lib/logger';
import type { InvocationOutputSink } from '../runner/invocation-result';
import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';
import { ensureSchegentGitignore } from './schegent-gitignore';
import {
  resolveContainedTarget,
  type ContainmentRefusal
} from '../lib/path-containment';
import { ensureAnchorWithinRoot, openWithinRoot, type SafeOpenRefusal } from '../lib/safe-open';
import {
  normalizeEvidenceFailureCause,
  type EvidenceHealthReporter
} from '../services/evidence-health/evidence-health-monitor';

const SESSION_START = '========== SESSION START ==========';
const SESSION_END = '========== SESSION END ==========';
const RAW_SPOOL_PREFIX = 'schegent-raw-spool-';

/** FR-R3-078 — promotion copy chunk; matches `lib/bounded-read.ts`'s. */
const COPY_CHUNK_BYTES = 64 * 1024;

/**
 * Feature FR-R3-005 (T328) — this file mutates in two separate trees and each
 * has its own root, so a guard here cannot be written against "the workspace"
 * alone. Spools live under `spoolRoot` (the OS temp area by default) because
 * they hold unredacted bytes and must not be strandable inside `.schegent`;
 * transcripts live under `<workspaceRoot>/.schegent/sessions`. A removal is
 * checked against the root of the tree it claims to be in, so a spool path
 * that resolves into the workspace is refused just as firmly as a transcript
 * path that resolves out of it.
 */
type SpoolRemoval = 'removed' | ContainmentRefusal;

/**
 * Prove containment, then remove. `resolveContainedTarget` rather than the link
 * form: a spool directory that is really a symlink elsewhere is not this
 * host's to delete through, and an `absent` target is already the outcome
 * `force: true` produces.
 */
async function removeIfContained(
  target: string,
  roots: readonly string[]
): Promise<SpoolRemoval> {
  const verdict = await resolveContainedTarget(target, roots);
  if (verdict.outcome === 'refused') return verdict.reason;
  if (verdict.outcome === 'absent') return 'removed';
  await fs.rm(verdict.resolved, { recursive: true, force: true });
  return 'removed';
}

export interface RawTranscriptStartInput {
  runId: string;
  phase: Phase;
  iteration: number;
  prompt: string;
  mode?: RawTranscriptMode;
}

export interface RawTranscriptEndInput {
  runId: string;
  stdout: string | ZippedStreamBuffer;
  stderr: string | ZippedStreamBuffer;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  /** FR-R3-075 -- the absolute deadline fired; rendered distinct from `timeout`. */
  deadlineExceeded?: boolean;
  /** Verbatim disk-backed stream capture, when one was available. */
  capture?: RawTranscriptCapture | null;
  mode?: RawTranscriptMode;
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
    private readonly onFailure: (err: Error) => void,
    private readonly spoolRoot: string,
    private readonly onRefusal: (reason: ContainmentRefusal) => void
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
    // Still marked disposed on a refusal: the spool is the host's to leave
    // alone, not to keep retrying. The OS temp sweep is the backstop, and the
    // refusal is what tells an operator why the directory is still there.
    const outcome = await removeIfContained(this.spoolDirectory, [this.spoolRoot]);
    if (outcome !== 'removed') this.onRefusal(outcome);
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
  /**
   * FR-R3-081 (T1081) — one write chain per run, and it is REMOVED when the run
   * is done with it.
   *
   * `M-10` named the monitor map and the transcript map; `FR-R3-052` bounded the
   * monitor half and recorded the other as outstanding. This is that half.
   * Measured before the fix: entries were added at three sites and deleted at
   * none, so the map held one promise per run id for the lifetime of the
   * extension host — a leak whose rate is "however many runs the operator
   * starts".
   *
   * The entry is dropped when its link settles and nothing newer has replaced
   * it — the identity check matters, because a later append can arrive while an
   * earlier one is still settling and the map must keep the newer chain. The
   * definitive removal is `finalizeRun`, which is where a run stops producing
   * transcript writes at all.
   */
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
    if (input.mode === 'off') return;
    const block = formatStartBlock(input);
    await this.enqueue(input.runId, block, input.mode ?? 'always');
  }

  /**
   * Creates a bounded-memory, disk-backed tee for one CLI invocation. The
   * returned sink applies WriteStream backpressure and is finalized by
   * `appendEnd`. Returns `null` on I/O failure so callers can retain the
   * legacy bounded-buffer fallback without failing the workflow.
   */
  public async createInvocationCapture(
    runId: string,
    mode: RawTranscriptMode = 'always'
  ): Promise<RawTranscriptCapture | null> {
    if (!runId) {
      this.warnEmptyRunId();
      return null;
    }
    if (mode === 'off') return null;
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
        (err) => this.warnStreamFailure(runId, err),
        this.spoolRoot,
        (reason) => this.warnContainmentRefusal('spool-dispose', reason)
      );
    } catch (err) {
      if (spoolDirectory) {
        try {
          const outcome = await removeIfContained(spoolDirectory, [this.spoolRoot]);
          if (outcome !== 'removed') this.warnContainmentRefusal('spool-cleanup', outcome);
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
    if (input.mode === 'off') {
      await input.capture?.dispose();
      return;
    }
    const previous = this.chains.get(input.runId) ?? Promise.resolve();
    const next = previous.then(() => this.doWriteEnd(input));
    this.chains.set(input.runId, next);
    this.releaseChainWhenSettled(input.runId, next);
    return next;
  }

  public async finalizeRun(
    runId: string,
    status: WorkflowRunStatus,
    mode: RawTranscriptMode
  ): Promise<void> {
    if (!runId || mode === 'always') return;
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const pending = this.filePathFor(runId, 'errors-only');
      const retained = this.filePathFor(runId, 'always');
      try {
        if (mode === 'off' || status === 'completed') {
          const outcomes = await Promise.all([
            this.removeTranscript(pending),
            this.removeTranscript(retained)
          ]);
          const refused = outcomes.find((outcome) => outcome !== 'removed');
          if (refused) this.warnContainmentRefusal('transcript-discard', refused);
        } else if (status === 'failed' || status === 'canceled' || status === 'paused') {
          await this.promoteThroughDescriptors(runId);
        }
      } catch (err) {
        this.warnWriteFailure(runId, err as Error);
      }
    });
    this.chains.set(runId, next);
    await next;
    // FR-R3-081 (T1081) — the definitive removal. A finalized run writes no more
    // transcript, so its chain entry has nothing left to order and holding it
    // would be the leak this bounds.
    if (this.chains.get(runId) === next) this.chains.delete(runId);
  }

  private filePathFor(runId: string, mode: RawTranscriptMode): string {
    return path.join(this.workspaceRoot, ...this.segmentsFor(runId, mode));
  }

  /**
   * FR-R3-053 — the same path as `filePathFor`, expressed as the segments
   * `openWithinRoot` walks. Both derive from this one list, so the pathname an
   * operator is shown and the one actually opened cannot diverge.
   */
  private segmentsFor(runId: string, mode: RawTranscriptMode): readonly string[] {
    const leaf = `raw-${runId}.log`;
    return mode === 'errors-only'
      ? ['.schegent', 'sessions', '.pending', leaf]
      : ['.schegent', 'sessions', leaf];
  }

  /**
   * Remove one transcript file, contained against the workspace. Keeps
   * `{ force: true }` and no `recursive` so the call is what it has always
   * been; the resolution in front of it is the only difference.
   */
  private async removeTranscript(target: string): Promise<SpoolRemoval> {
    const verdict = await resolveContainedTarget(target, [this.workspaceRoot]);
    if (verdict.outcome === 'refused') return verdict.reason;
    if (verdict.outcome === 'absent') return 'removed';
    await fs.rm(verdict.resolved, { force: true });
    return 'removed';
  }

  /**
   * The path to append to, or `null` when containment could not be proven.
   * `resolveContainedForWrite` rather than the target form: the first write of
   * a run creates the file, and a leaf that does not exist yet still has an
   * ancestry worth resolving.
   */
  /**
   * FR-R3-078 (T1049) — promote the pending transcript to its retained name
   * against handles the checked walk produced.
   *
   * What this replaces was `resolveContainedLink` on two pathnames followed by
   * `fs.rename` on those same pathnames: a verdict about two names, and then an
   * operation on the names. A concurrent workspace writer that swapped a parent
   * component in between moved unredacted evidence out of the workspace, which
   * is `SEC-03` exactly.
   *
   * WHY A COPY AND NOT A RENAME (T1050). Node exposes no `renameat`, and
   * `/proc/self/fd` is Linux-only, so a rename cannot be made handle-relative —
   * the same wall `FR-R3-053` §5 residual 1 hit. That dependency question belonged
   * to `FR-R3-083` and has since been answered **no**
   * (`docs/architecture/native-binding-decision.md`), so the copy below is not an
   * interim shape awaiting a binding; it is what this module ships. The item's requirement is handles *or a
   * refusal*, so the promotion is performed as a descriptor-to-descriptor copy
   * followed by a contained removal of the source. Every filesystem operation
   * then acts on something the walk produced.
   *
   * THE RESIDUAL THIS COSTS, stated rather than implied: the promotion is no
   * longer atomic. If the host dies between the copy and the removal, the
   * pending transcript survives and the retained file is complete — the next
   * `finalizeRun` or spool scavenge reclaims the pending one. The destination is
   * opened `wx`, so a partial retained file left by an earlier crash is detected
   * as `EEXIST` rather than silently appended to. Losing atomicity to gain
   * containment is the right direction for a stream the threat model marks
   * deliberately unredacted; the reverse would not be.
   */
  private async promoteThroughDescriptors(runId: string): Promise<void> {
    const source = await openWithinRoot(
      this.workspaceRoot,
      this.segmentsFor(runId, 'errors-only'),
      { flags: 'r' }
    );
    if (source.outcome === 'refused') {
      // Nothing to promote is not a refusal: a run that produced no pending
      // transcript is the ordinary case for `errors-only` with no output.
      if (source.reason !== 'io-failed' || source.errno !== 'ENOENT') {
        this.warnContainmentRefusal('transcript-promote', source.reason);
      }
      return;
    }
    // `wx` FIRST, so a retained transcript that is already there is detected
    // rather than written through — a partial one left by a crash between the
    // copy and the removal must not be silently mistaken for a complete file.
    const destinationSegments = this.segmentsFor(runId, 'always');
    let destination = await openWithinRoot(this.workspaceRoot, destinationSegments, {
      flags: 'wx',
      createDirs: true,
      dirMode: 0o700,
      fileMode: 0o600
    });
    // EEXIST is not a refusal, and treating it as one stranded evidence. A run
    // id is promoted more than once whenever it is RESUMED: `onRunTerminal`
    // fires on `paused` as well as on the terminal statuses, `resumeExisting`
    // reuses the same `run.id`, and the resumed leg writes a fresh pending
    // transcript. With `wx` alone the second promotion reported
    // `transcript-promote refused: containment io-failed` and left the whole
    // post-resume transcript in `.pending`, where session retention eventually
    // reaps it — the run's evidence for the leg that actually failed.
    //
    // So the destination is REOPENED for append and the legs accumulate in
    // order, which is what a reader of a resumed run's transcript wants. The
    // old `fs.rename` replaced the file and lost the earlier leg instead; this
    // loses neither.
    if (
      destination.outcome === 'refused' &&
      destination.reason === 'io-failed' &&
      destination.errno === 'EEXIST'
    ) {
      destination = await openWithinRoot(this.workspaceRoot, destinationSegments, {
        flags: 'a',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
    }
    if (destination.outcome === 'refused') {
      await source.handle.close().catch(() => undefined);
      // The pending transcript stays where it is rather than being promoted. It
      // is the evidence for a run that did not complete, so leaving it is the
      // conservative half of the refusal.
      this.warnContainmentRefusal('transcript-promote', destination.reason);
      return;
    }
    const destinationHandle = destination.handle;
    try {
      await copyBetweenHandles(source.handle, destinationHandle);
    } finally {
      await destinationHandle.close().catch(() => undefined);
      await source.handle.close().catch(() => undefined);
    }
    // Only after the destination is closed: an unlinked source with an unwritten
    // destination is the one ordering that loses evidence outright.
    const removed = await this.removeTranscript(this.filePathFor(runId, 'errors-only'));
    if (removed !== 'removed') this.warnContainmentRefusal('transcript-promote', removed);
  }

  private enqueue(runId: string, content: string, mode: RawTranscriptMode): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.doWrite(runId, content, mode));
    this.chains.set(runId, next);
    this.releaseChainWhenSettled(runId, next);
    return next;
  }

  /**
   * FR-R3-081 (T1081) — drop a run's chain entry once it has nothing pending.
   *
   * The identity check is the whole of it: `this.chains.get(runId) === settled`
   * is false whenever a newer append has already replaced this link, and
   * deleting then would drop a chain that still has work behind it.
   */
  private releaseChainWhenSettled(runId: string, settled: Promise<void>): void {
    void settled
      .catch(() => undefined)
      .then(() => {
        if (this.chains.get(runId) === settled) this.chains.delete(runId);
      });
  }

  private async doWrite(runId: string, content: string, mode: RawTranscriptMode): Promise<void> {
    try {
      await this.ensureRuntimeGitignore();
      // FR-R3-053 (H-02) — one open that walks and refuses, replacing
      // `mkdir -p` + a containment VERDICT + `appendFile` on the same pathname.
      // The verdict was true when taken and re-resolved on the write, which is
      // the check-to-use window this primitive exists to close. It matters more
      // here than almost anywhere: raw transcripts are deliberately unredacted
      // (see the threat model), so a symlink redirect leaks the unredacted stream
      // out of the workspace.
      const opened = await openWithinRoot(this.workspaceRoot, this.segmentsFor(runId, mode), {
        flags: 'a',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (opened.outcome === 'refused') {
        this.warnContainmentRefusal('transcript-append', opened.reason);
        return;
      }
      try {
        await opened.handle.write(content, null, 'utf8');
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    } catch (err) {
      this.warnWriteFailure(runId, err as Error);
    }
  }

  private async doWriteEnd(input: RawTranscriptEndInput): Promise<void> {
    const mode = input.mode ?? 'always';
    try {
      await this.ensureRuntimeGitignore();

      // FR-R3-078 (T1047) — one open that walks and refuses, replacing raw
      // `fs.mkdir` + a containment VERDICT + `fs.open` on the same pathname.
      //
      // The append path was migrated by FR-R3-053 and this half was not, which
      // made this module a partially migrated one — and a partially migrated
      // module is an unmigrated one. The defect the verdict left behind is not
      // that it was wrong; it was true when it was taken. It is that the path
      // was re-resolved BY NAME afterwards, so a concurrent workspace writer
      // that swapped a parent component in between redirected the write. What
      // this stream carries is deliberately unredacted by the threat model, so
      // the redirect is a disclosure and not merely a misplaced file.
      //
      // The rewind in `appendCapturedOrBuffered` truncates this already-open
      // handle and names no path of its own, so it inherits the walk's proof
      // rather than repeating it.
      const opened = await openWithinRoot(this.workspaceRoot, this.segmentsFor(input.runId, mode), {
        flags: 'a',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (opened.outcome === 'refused') {
        // FR-R3-078 (T1048) — the refusal names the link, through the same
        // channel the append path uses. An I/O failure still goes to
        // `warnWriteFailure` below; the two are never conflated, because
        // "someone moved this path" and "the disk is full" call for different
        // responses.
        this.warnContainmentRefusal('transcript-write', opened.reason);
        return;
      }
      const handle = opened.handle;
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

  /**
   * Feature FR-R3-005 (T328). Its own line, distinct from a cleanup failure:
   * an operator reading `spool cleanup failed` goes looking for a full disk,
   * and this is the opposite finding — the I/O never ran because the path did
   * not lead where it claimed. `operation` and `reason` are both bounded
   * literals, so the line names no location.
   */
  /**
   * FR-R3-053 — widened to carry a `SafeOpenRefusal` too.
   *
   * The safe-open refusals are more specific than the containment ones
   * (`symlink-component`, `symlink-leaf`, `not-a-directory`), and mapping them
   * down to `not-contained` would discard exactly the part an operator can act
   * on: "something put a link where the transcript directory belongs" is a
   * different problem from "this path resolves outside the workspace".
   */
  private warnContainmentRefusal(
    operation: string,
    reason: ContainmentRefusal | SafeOpenRefusal
  ): void {
    // FR-R3-080 (T1075) — reported as a REFUSAL, not as a cleanup failure. The
    // distinction is what routes it to a phase-end warning an operator sees, and
    // it is also simply true: nothing failed here, a write was declined because
    // its path could not be proven.
    const shouldWarn = this.evidenceHealth?.reportFailure('rawTranscript', 'path-refused') ?? true;
    if (!shouldWarn) return;
    this.logger.warn(
      `raw transcript ${operation} refused: containment ${reason}; workflow continues with degraded raw evidence`
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
    this.spoolScavenge ??= scavengeAbandonedSpools(this.spoolRoot, (reason) =>
      this.warnContainmentRefusal('spool-scavenge', reason)
    ).catch(() => {
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

async function scavengeAbandonedSpools(
  spoolRoot: string,
  // FR-R3-078 — widened to the walk's refusal vocabulary too: the anchor below
  // refuses in `SafeOpenRefusal` terms, and `warnContainmentRefusal` has always
  // accepted both. Narrowing here would have forced a cast at the one site that
  // knows the real reason.
  onRefusal: (reason: ContainmentRefusal | SafeOpenRefusal) => void
): Promise<void> {
  // FR-R3-078 (T1051) — the spool root through the root-creating primitive
  // rather than a raw recursive `mkdir` on a composed pathname.
  //
  // A RECORDED DEVIATION. The item asks for this root to be created "beneath the
  // workspace root". It is not, and it must not be: this module's header records
  // why spools live in the OS temp area — a spool is host-owned scratch that has
  // to survive the workspace the run is mutating, and the scavenge below reaps
  // spools left by OTHER windows' dead PIDs, which a per-workspace location
  // cannot see. Relocating unredacted spool evidence into the tree a run is
  // editing would widen the very exposure this item exists to narrow.
  //
  // What the item's intent actually asks for is that no raw recursive `mkdir`
  // composes a pathname unchecked, and that is met: the anchor is the spool
  // root's PARENT — the OS temp directory, this process's trust anchor, in the
  // same sense `services/run-checkpoint-service.ts` treats VS Code's global
  // storage — and the final component is walked. When `spoolRoot` is `os.tmpdir()`
  // itself the call verifies an existing anchor and creates nothing.
  const anchored = await ensureAnchorWithinRoot(
    path.dirname(spoolRoot),
    [path.basename(spoolRoot)],
    0o700
  );
  if (anchored.outcome === 'refused') {
    onRefusal(anchored.reason);
    return;
  }
  const entries = await fs.readdir(spoolRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^schegent-raw-spool-(\d+)-/);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;
    // The `isDirectory()` filter already drops a symlinked entry — a `Dirent`
    // for a link reports neither file nor directory — but that is a property
    // of the enumeration, not a containment check, and it says nothing about
    // the components above it. This sweep runs over a shared OS temp area, so
    // it is the one removal here an unrelated process can arrange the shape of.
    const outcome = await removeIfContained(path.join(spoolRoot, entry.name), [spoolRoot]);
    if (outcome !== 'removed') onRefusal(outcome);
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

/**
 * FR-R3-078 (T1049) — move bytes between two handles the checked walk produced.
 *
 * Chunked rather than `readFile`: a raw transcript is whatever the backend
 * emitted, which is not a size this host chose, and the promotion must not cost
 * the file. The chunk is the same 64 KiB `lib/bounded-read.ts` uses, for the
 * same reason.
 */
async function copyBetweenHandles(source: FileHandle, destination: FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) return;
    await destination.write(buffer, 0, bytesRead);
    offset += bytesRead;
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
  if (input.deadlineExceeded === true) return 'deadline';
  if (input.timedOut) return 'timeout';
  if (input.exitCode === null) return 'null';
  return String(input.exitCode);
}
