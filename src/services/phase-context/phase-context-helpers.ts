/**
 * FR-R6-F15 (F15-B) — shared phase-context token sanitization, bounded file-handle reading,
 * and NFR-003 admission wait queue helpers.
 *
 * Zero `vscode` or raw `node:fs` path-creating imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import type { AcpPromptBlock, NegotiatedCapabilities } from '../../contracts/acp-runtime';
import type { DeliveryRepresentation } from '../../contracts/phase-context/context-delivery';
import { PHASE_CONTEXT_LIMITS, type Refusal } from '../../contracts/phase-context/context-policy';
import { checkDispatch } from './delivery-plan';
import type { PreparationAdmission } from './preparation-admission';
import { refuse, sha256Hex } from './primitives';

/**
 * Canonical filesystem- and artifact-ID-safe token sanitizer shared across staging, immutable
 * capture, materialization, delivery fallback lookup, and F05 pin release.
 *
 * Tokens up to 80 ASCII chars pass through cleaned; longer tokens preserve a 63-char prefix plus
 * a 16-hex SHA-256 suffix of the raw input (80 chars total) so distinct long IDs never collide
 * and every producer/consumer computes the exact same directory segment and `res-*`/`mat-*` ID.
 */
export function sanitizePhaseContextToken(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '');
  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= 80) return cleaned;
  const suffix = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${cleaned.slice(0, 63)}-${suffix}`;
}

/**
 * Canonical collision-free F05 artifact ID for a materialized handoff copy.
 * Preserves `mat-<cleanArt>-<cleanAttempt>` when <= 120 chars; longer combinations fold the raw
 * `(artifactId, attemptId, digestHex)` inputs into a 16-hex SHA-256 suffix (120 chars total).
 */
export function materializedCopyArtifactId(
  artifactId: string,
  attemptId: string,
  digestHex?: string
): string {
  const cleanArt = sanitizePhaseContextToken(artifactId, 'art');
  const cleanAttempt = sanitizePhaseContextToken(attemptId, 'attempt');
  const raw = `mat-${cleanArt}-${cleanAttempt}`;
  if (raw.length <= 120) return raw;
  const suffix = sha256Hex(JSON.stringify([artifactId, attemptId, digestHex ?? ''])).slice(0, 16);
  return `${raw.slice(0, 103)}-${suffix}`;
}

export type BoundedBytesReadResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'not-a-file' | 'oversized' | 'truncated' | 'io-error' };

/**
 * Reads an already-opened regular file handle in bounded chunks up to `maxBytes`, probing one
 * byte past `maxBytes` so concurrent file growth cannot bypass the limit or cause an unbounded
 * `readFile()` allocation.
 */
export async function readBoundedBytesFromHandle(
  handle: Pick<FileHandle, 'stat' | 'read'>,
  maxBytes: number
): Promise<BoundedBytesReadResult> {
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    if (stat.size > maxBytes) return { ok: false, reason: 'oversized' };
    const chunkCap = Math.min(
      PHASE_CONTEXT_LIMITS.materializationStreamBytesMax,
      Math.max(4096, Math.min(stat.size + 1, maxBytes + 1))
    );
    const chunkBuf = Buffer.allocUnsafe(chunkCap);
    const chunks: Buffer[] = [];
    let totalRead = 0;
    for (;;) {
      const remaining = maxBytes + 1 - totalRead;
      const toRead = Math.min(chunkBuf.length, remaining);
      if (toRead <= 0) return { ok: false, reason: 'oversized' };
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
      if (totalRead > maxBytes) return { ok: false, reason: 'oversized' };
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }
    if (totalRead < stat.size) return { ok: false, reason: 'truncated' };
    return { ok: true, bytes: Buffer.concat(chunks, totalRead) };
  } catch {
    // Bounded handle read classifies all underlying handle errors as io-error.
    return { ok: false, reason: 'io-error' };
  }
}

interface AdmissionWaiterEntry {
  readonly bytes: number;
  readonly settle: (outcome: { readonly ok: true } | Refusal) => void;
}

/**
 * Manages queued NFR-003 preparation admission waiters with leak-free unconditional timer teardown
 * and expiry-first polling so stalled active owners release slots before queued waiters time out.
 */
export class AdmissionWaiterQueue {
  private readonly waiters = new Map<string, AdmissionWaiterEntry>();

  public constructor(
    private readonly admission: PreparationAdmission,
    private readonly clock: () => number
  ) {}

  public notifyPromoted(): void {
    for (const [ownerKey, waiter] of [...this.waiters.entries()]) {
      const check = this.admission.request(ownerKey, waiter.bytes);
      if (!check.ok) {
        waiter.settle(check);
      } else if (check.state === 'active') {
        waiter.settle({ ok: true });
      }
    }
  }

  public release(ownerKey: string): void {
    this.admission.release(ownerKey);
    this.notifyPromoted();
  }

  public waitForActivation(
    ownerKey: string,
    bytes: number
  ): Promise<{ readonly ok: true } | Refusal> {
    const enqueuedClockMs = this.clock();
    const wallStartMs = Date.now();
    const deadlineMs = PHASE_CONTEXT_LIMITS.preparationDeadlineMs;

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const settle = (outcome: { readonly ok: true } | Refusal): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        const current = this.waiters.get(ownerKey);
        if (current?.settle === settle) {
          this.waiters.delete(ownerKey);
        }
        resolve(outcome);
      };

      const poll = (): void => {
        // Expire stalled active owners FIRST so freed slots promote queued waiters cleanly.
        if (this.admission.expire().length > 0) {
          this.notifyPromoted();
          if (settled) return;
        }
        const check = this.admission.request(ownerKey, bytes);
        if (!check.ok) {
          settle(check);
          return;
        }
        if (check.state === 'active') {
          settle({ ok: true });
          return;
        }
        if (
          this.clock() - enqueuedClockMs > deadlineMs ||
          Date.now() - wallStartMs > deadlineMs
        ) {
          this.admission.release(ownerKey);
          this.notifyPromoted();
          settle(refuse('capacity-exceeded', 'preparation-deadline'));
        }
      };

      timer = setInterval(poll, 10);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.waiters.set(ownerKey, { bytes, settle });
    });
  }
}

/**
 * FR-013 / FR-035 — verifies real ACP `initialize`-negotiated capabilities, active runner profile,
 * and handoff content integrity before `session/load` or `session/prompt` in `AcpBackedRunner`.
 */
export function verifyNegotiatedHandoffCapabilities(params: {
  readonly negotiated: NegotiatedCapabilities | null;
  readonly representation: DeliveryRepresentation | null;
  readonly activeProfile?: { readonly profileId: string; readonly profileRevision: number } | undefined;
  readonly expectedContentDigest?: string | undefined;
  readonly expectedHandoffId?: string | undefined;
  readonly expectedRepresentationDigest?: string | undefined;
  readonly acpPromptBlocks?: readonly AcpPromptBlock[] | undefined;
  readonly wantsLoadSession: boolean;
  readonly isContinue: boolean;
}):
  | { readonly ok: true; readonly forceFreshSession: boolean; readonly warning?: string }
  | { readonly ok: false; readonly warning: string } {
  const { negotiated, representation } = params;
  if (params.expectedHandoffId !== undefined) {
    if (representation === null) {
      return {
        ok: false,
        warning: 'acp-handoff-dispatch-refused:storage-unavailable:representation-missing'
      };
    }
    if (
      representation.handoffId !== params.expectedHandoffId ||
      (params.expectedRepresentationDigest !== undefined &&
        representation.representationDigest !== params.expectedRepresentationDigest)
    ) {
      return {
        ok: false,
        warning: 'acp-handoff-dispatch-refused:stale-revision:representation-digest'
      };
    }
  }
  if (representation !== null) {
    if (negotiated === null) {
      return { ok: false, warning: 'acp-handoff-dispatch-refused:stale-revision:capabilities-changed' };
    }
    const profileToCheck =
      params.activeProfile !== undefined
        ? {
            profileId: params.activeProfile.profileId,
            profileRevision: params.activeProfile.profileRevision,
            qualifiedContextBytes: 1
          }
        : { profileId: '', profileRevision: -1, qualifiedContextBytes: 1 };
    let contentDigestToCheck = params.expectedContentDigest;
    if (params.acpPromptBlocks !== undefined && params.acpPromptBlocks.length > 0) {
      const renderedBlock =
        params.acpPromptBlocks.length > 1 ? params.acpPromptBlocks[1] : undefined;
      if (
        renderedBlock === undefined ||
        renderedBlock.type !== 'text' ||
        sha256Hex(renderedBlock.text) !== representation.renderedDigest
      ) {
        return { ok: false, warning: 'acp-handoff-dispatch-refused:stale-revision:content-changed' };
      }
      contentDigestToCheck ??= representation.contentDigest;
    }
    const checked = checkDispatch(representation, {
      capabilities: negotiated,
      profile: profileToCheck,
      contentDigest: contentDigestToCheck ?? ''
    });
    if (!checked.ok) {
      return {
        ok: false,
        warning: `acp-handoff-dispatch-refused:${checked.failure}:${checked.detail}`
      };
    }
    if (representation.session === 'fresh' && params.wantsLoadSession) {
      return {
        ok: false,
        warning: 'acp-handoff-dispatch-refused:invalid-policy:session-reuse-not-permitted'
      };
    }
    if (representation.session === 'reuse' && !negotiated.loadSession) {
      return { ok: false, warning: 'acp-handoff-capabilities-changed:session-load-unsupported' };
    }
  }

  const hasEmbedded = params.acpPromptBlocks?.some((b) => b.type === 'embedded-resource') === true;
  if (hasEmbedded && (negotiated === null || !negotiated.embeddedContext)) {
    return { ok: false, warning: 'acp-handoff-capabilities-changed:embedded-context-unsupported' };
  }

  if (params.wantsLoadSession && (negotiated === null || !negotiated.loadSession)) {
    return { ok: false, warning: 'acp-handoff-capabilities-changed:session-load-unsupported' };
  }

  return { ok: true, forceFreshSession: false };
}
