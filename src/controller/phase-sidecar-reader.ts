import * as path from 'path';
import * as fs from 'fs/promises';
import type { Phase } from './phase';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { AuditEntryFields } from '../audit/audit-entry';
import type { SanitizedLogger } from '../lib/logger';
import { BUILT_IN_PIPELINE_ID, type PhaseDef } from '../config/pipeline-config';

/**
 * Single source of truth for the canonical `phase-message.env` sidecar
 * path. Mirrors the verbose-diagnostic iter-N directory composition so
 * the host controller and the runner's audit-candidate Step-2 dedup
 * logic both resolve to the same absolute path. Returns the absolute
 * composed path (does NOT touch the filesystem; existence is probed by
 * the caller via `fs.open(..., O_NOFOLLOW)`).
 */
export function composePhaseMessagePath(args: {
  cwd: string;
  runId: string;
  pipelineId: string;
  phaseId: string;
  iteration: number;
}): string {
  return path.join(
    args.cwd,
    '.schegent',
    'sessions',
    args.runId,
    'diagnostics',
    args.pipelineId,
    args.phaseId,
    `iter-${args.iteration}`,
    'phase-message.env'
  );
}

export interface PhaseMessageResult {
  readonly fromPhaseId: string;
  readonly entryCount: number;
  readonly byteSize: number;
  readonly entries: Readonly<Record<string, string>>;
  readonly truncated: boolean;
  readonly invalidReason: string | null;
}

export interface PhaseSidecarInputs {
  readonly phase: Phase;
  readonly phaseDef?: PhaseDef;
  readonly pipelineId?: string;
  readonly runId: string;
  readonly iteration: number;
  readonly cwd: string;
  readonly phaseMessagePath?: string | null;
}

export class PhaseSidecarReader {
  constructor(
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: Pick<SanitizedLogger, 'sanitizeRecord'>
  ) {}

  /**
   * Feature 056 Track 2 — compute the canonical host-computed sidecar
   * path. Mirrors the verbose-diagnostic iter-N directory composition
   * so a single source of truth governs both diagnostic and sidecar
   * paths. Returns `null` when required inputs (runId, iteration) are
   * absent — exists only to keep legacy test fixtures working.
   */
  public canonicalSidecarPath(inputs: PhaseSidecarInputs): string | null {
    if (inputs.phaseMessagePath) return path.resolve(inputs.phaseMessagePath);
    if (!inputs.runId || !inputs.iteration) return null;
    return composePhaseMessagePath({
      cwd: inputs.cwd,
      runId: inputs.runId,
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      iteration: inputs.iteration
    });
  }

  public async parsePhaseMessage(
    inputs: PhaseSidecarInputs,
    auditEntry: AuditEntryFields | null
  ): Promise<PhaseMessageResult | null> {
    // Feature 056 Track 2 (FR-006..FR-012) — Canonical-path defense.
    //
    // The CLI stdout (and therefore the audit `filesCreated` /
    // `filesModified` arrays) is operator-influenced and can contain
    // attacker-supplied paths via a malicious phase prompt or repo
    // file. The previous implementation filtered candidates only by
    // basename, which let `/private/var/.../phase-message.env` slip
    // through. Track 2 closes that gap:
    //
    //   1. Prefer the host-computed canonical path entirely. When the
    //      file at `inputs.phaseMessagePath` exists on disk, read it
    //      and ignore every audit-reported candidate.
    //   2. Otherwise, audit candidates are checked against the
    //      canonical path with `path.resolve` (handles `..`, relative
    //      paths). Anything that does not byte-match the canonical
    //      path is rejected with `path-outside-run-dir`. If no
    //      candidate matches, emit `missing-canonical-sidecar`.
    const canonicalPath = this.canonicalSidecarPath(inputs);
    if (!canonicalPath) {
      // No canonical path available (legacy inputs without runId etc.).
      // Fall back to the prior basename behavior so existing tests
      // that omit phaseMessagePath continue to pass. This branch is
      // only reachable in test fixtures.
      const fallback = [
        ...(auditEntry?.filesCreated ?? []),
        ...(auditEntry?.filesModified ?? [])
      ].filter((file) => path.basename(file) === 'phase-message.env');
      if (fallback.length === 0) return null;
      return this.readAndParsePhaseMessage(inputs, fallback[0]);
    }
    // Step 1: try the canonical path directly. The open() IS the probe
    // — a separate `fs.lstat` prelude would only re-open a TOCTOU race
    // it could not close (an attacker could swap the file between the
    // probe and the open). When `silentOnFailure` is on, any failure
    // (ENOENT, ELOOP / symlink, EACCES, type-mismatch) returns `null`
    // with no audit emission so Step 2 can make the definitive call
    // from the audit candidates; a `null` return is therefore "Step 1
    // declined" and never reflects a successful-but-invalid parse.
    const canonicalResult = await this.readAndParsePhaseMessage(
      inputs,
      canonicalPath,
      { silentOnFailure: true }
    );
    if (canonicalResult !== null) return canonicalResult;
    // Step 2: examine audit candidates by canonical-path equality.
    //
    // Symlink-tolerant canonical-path resolution. The host-composed
    // `canonicalPath` is a lexical join under `inputs.cwd`. On macOS
    // dev boxes the system tmpdir and any `/var/...` workspace anchor
    // realpath to `/private/var/...`; on some Linux distros `/var/run`
    // realpaths to `/run`. The CLI subprocess realpath()-resolves its
    // own cwd before reporting `filesCreated` / `filesModified` back,
    // so its candidates carry the realpath-resolved prefix while our
    // canonical keeps the symlink-side prefix. A naive byte-equality
    // would reject the legitimate sidecar.
    let canonicalRealpath: string;
    try {
      canonicalRealpath = await fs.realpath(canonicalPath);
    } catch {
      canonicalRealpath = canonicalPath;
    }
    // Dedup by realpath where possible: the CLI commonly reports the
    // same sidecar in BOTH `filesCreated` and `filesModified` (a file
    // that is created and then written within the same phase), and a
    // raw concat would tally that as `candidateCount = 2` and emit a
    // false-positive `duplicate-sidecar` audit. Realpath also collapses
    // parent-component-symlink variants and case-insensitive FS
    // variants. When realpath fails (file doesn't exist on disk, or
    // permission denied), we fall back to the lexically-resolved path
    // as the dedup key — same-string entries still dedup correctly.
    const candidateDedup = new Map<string, string>();
    for (const file of [
      ...(auditEntry?.filesCreated ?? []),
      ...(auditEntry?.filesModified ?? [])
    ]) {
      if (path.basename(file) !== 'phase-message.env') continue;
      const resolved = path.resolve(inputs.cwd, file);
      let key = resolved;
      try {
        key = await fs.realpath(resolved);
      } catch {
        // Lexical key fallback — the resolved path is already
        // normalized, so byte-identical inputs still collapse.
      }
      if (!candidateDedup.has(key)) {
        candidateDedup.set(key, resolved);
      }
    }
    const auditCandidates = Array.from(candidateDedup.entries());
    if (auditCandidates.length === 0) return null;
    if (auditCandidates.length > 1) {
      await this.emitPhaseMessageInvalid(inputs, 'duplicate-sidecar', {
        candidateCount: auditCandidates.length
      });
    }
    let acceptedCandidate: string | null = null;
    let rejectedOutside = false;
    for (const [key, resolved] of auditCandidates) {
      if (resolved === canonicalPath || key === canonicalRealpath) {
        acceptedCandidate = resolved;
        break;
      }
      rejectedOutside = true;
    }
    if (acceptedCandidate === null) {
      const reason = rejectedOutside
        ? 'path-outside-run-dir'
        : 'missing-canonical-sidecar';
      await this.emitPhaseMessageInvalid(inputs, reason);
      return this.invalidPhaseMessage(inputs, reason);
    }
    return this.readAndParsePhaseMessage(inputs, acceptedCandidate);
  }

  /**
   * Build the boilerplate `PhaseMessageResult` returned on every
   * invalid-reason branch.
   */
  public invalidPhaseMessage(
    inputs: PhaseSidecarInputs,
    reason: string
  ): PhaseMessageResult {
    return {
      fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
      entryCount: 0,
      byteSize: 0,
      entries: {},
      truncated: false,
      invalidReason: reason
    };
  }

  /**
   * Audit-emission helper for the `phase-message-invalid` envelope.
   */
  public async emitPhaseMessageInvalid(
    inputs: PhaseSidecarInputs,
    reason: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await this.appendAudit(inputs, 'phase-message-invalid', 'info', {
      ...this.pipelineMeta(inputs),
      reason,
      ...extra
    });
  }

  public async readAndParsePhaseMessage(
    inputs: PhaseSidecarInputs,
    absolutePath: string,
    options: { silentOnFailure?: boolean } = {}
  ): Promise<PhaseMessageResult | null> {
    // Feature 056 Track 2 (FR-006..FR-012) — symlink-safe read, TOCTOU-closed.
    //
    // The fix: `fs.open(path, O_RDONLY | O_NOFOLLOW)` then read via the FD.
    //   - `O_NOFOLLOW` makes the kernel atomically reject the open with
    //     ELOOP if the FINAL path component is a symlink — no separate
    //     "check then act" window for an attacker to exploit.
    //   - `handle.stat()` binds to the FD (fstat semantics), not the path,
    //     so any post-open swap cannot deceive the size/type check.
    //   - `handle.readFile()` reads from the FD, not the path.
    //
    // Platform note: `O_NOFOLLOW` is a POSIX constant. On Windows it is
    // not present; we OR with `0` (identity) and rely on Windows' own
    // symlink-creation ACL (admin or Developer Mode) for partial defense.
    const silent = options.silentOnFailure === true;
    const NOFOLLOW: number =
      (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let handle: fs.FileHandle | null = null;
    let bytes: Buffer;
    try {
      handle = await fs.open(
        absolutePath,
        fs.constants.O_RDONLY | NOFOLLOW
      );
      const stat = await handle.stat();
      if (!stat.isFile()) {
        if (silent) return null;
        await this.emitPhaseMessageInvalid(inputs, 'missing-sidecar');
        return this.invalidPhaseMessage(inputs, 'missing-sidecar');
      }
      bytes = await handle.readFile();
      // Windows defense-in-depth: lstat after read catches the case where
      // open() followed a symlink at the dentry level (no O_NOFOLLOW on Win).
      try {
        const lstAfterRead = await fs.lstat(absolutePath);
        if (lstAfterRead.isSymbolicLink()) {
          if (silent) return null;
          await this.emitPhaseMessageInvalid(inputs, 'path-symlink-redirect');
          return this.invalidPhaseMessage(inputs, 'path-symlink-redirect');
        }
      } catch {
        // lstat failed (e.g. file vanished mid-read). Falling through
        // means we trust the bytes we already read.
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        if (silent) return null;
        await this.emitPhaseMessageInvalid(inputs, 'path-symlink-redirect');
        return this.invalidPhaseMessage(inputs, 'path-symlink-redirect');
      }
      if (silent) return null;
      await this.emitPhaseMessageInvalid(inputs, 'missing-sidecar');
      return this.invalidPhaseMessage(inputs, 'missing-sidecar');
    } finally {
      await handle?.close();
    }
    const byteSize = bytes.byteLength;
    if (byteSize > 4096) {
      await this.appendAudit(inputs, 'phase-message-truncated', 'info', {
        ...this.pipelineMeta(inputs),
        byteSize
      });
      return {
        fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
        entryCount: 0,
        byteSize,
        entries: {},
        truncated: true,
        invalidReason: null
      };
    }
    const parsed = this.parsePhaseMessageEnv(bytes.toString('utf8'));
    if (parsed.duplicateKey) {
      await this.emitPhaseMessageInvalid(inputs, 'duplicate-keys');
      return { ...this.invalidPhaseMessage(inputs, 'duplicate-keys'), byteSize };
    }
    if (parsed.invalidLines > 0 || parsed.invalidKeys > 0) {
      await this.emitPhaseMessageInvalid(inputs, 'malformed-lines', {
        invalidLines: parsed.invalidLines,
        invalidKeys: parsed.invalidKeys
      });
    }
    const sanitized = this.logger.sanitizeRecord(parsed.entries) as Record<string, string>;
    const entryCount = Object.keys(sanitized).length;
    await this.appendAudit(inputs, 'phase-message-emitted', 'info', {
      ...this.pipelineMeta(inputs),
      entryCount,
      byteSize
    });
    return {
      fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
      entryCount,
      byteSize,
      entries: sanitized,
      truncated: false,
      invalidReason: entryCount === 0 ? 'unparseable' : null
    };
  }

  public parsePhaseMessageEnv(text: string): {
    entries: Record<string, string>;
    invalidLines: number;
    invalidKeys: number;
    duplicateKey: boolean;
  } {
    const entries: Record<string, string> = {};
    let invalidLines = 0;
    let invalidKeys = 0;
    let duplicateKey = false;
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.trim().length === 0) continue;
      const sep = rawLine.indexOf('=');
      if (sep <= 0) {
        invalidLines++;
        continue;
      }
      const key = rawLine.slice(0, sep);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) {
        invalidKeys++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(entries, key)) {
        duplicateKey = true;
        continue;
      }
      entries[key] = rawLine.slice(sep + 1);
    }
    return { entries, invalidLines, invalidKeys, duplicateKey };
  }

  private pipelineMeta(inputs: PhaseSidecarInputs): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase
    };
    if (inputs.phaseDef?.model) meta.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) meta.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      meta.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    return meta;
  }

  private appendAudit(
    inputs: PhaseSidecarInputs,
    eventType: 'phase-message-emitted' | 'phase-message-truncated' | 'phase-message-invalid',
    outcome: 'success' | 'failure' | 'info',
    payload: Record<string, unknown>
  ) {
    return this.auditWriter.append({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType,
      payload,
      outcome
    });
  }
}
