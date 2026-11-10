/**
 * FR-R6-F08 (FR-001, FR-002) — the recovery envelope reads the handoff service makes.
 *
 * The envelope itself stays where `RunCheckpointService` keeps it. This module reaches it through
 * a structural port, so the real service satisfies the port without an adapter, and reports each
 * outcome as a handoff result instead of an envelope diagnostic list.
 *
 * The envelope digest is the SHA-256 of the JSON of the re-validated envelope, so the same
 * envelope read twice, or captured and then read, has the same digest.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import {
  validateRecoveryEnvelope,
  type RecoveryEffectCertainty,
  type RecoveryEnvelope,
  type RecoveryWorkspaceCoverage
} from '../../contracts/recovery-envelope';
import type { HandoffRefusal } from '../../contracts/recovery-handoff/handoff-types';
import type { RunCheckpointService } from '../run-checkpoint-service';

/** The two `RunCheckpointService` members the handoff service uses. */
export type RecoveryEnvelopePort = Pick<RunCheckpointService, 'captureAndPersistCandidateHandover' | 'readRecoveryEnvelope'>;

export type CaptureCandidateOptions = Parameters<RecoveryEnvelopePort['captureAndPersistCandidateHandover']>[2];

const NEWER_ENVELOPE_CODE = 'unsupported-recovery-envelope-version';

export type CaptureCandidateResult =
  | {
      readonly ok: true;
      readonly envelopeDigest: string;
      readonly coverage: RecoveryWorkspaceCoverage;
      readonly certainty: RecoveryEffectCertainty;
    }
  | (HandoffRefusal<'capture-failed'> & { readonly diagnostic: string });

export type AssessAttemptResult =
  | { readonly ok: true; readonly envelope: RecoveryEnvelope; readonly envelopeDigest: string }
  | HandoffRefusal<'context-missing' | 'context-invalid' | 'unsupported-version'>;

/** SHA-256 of the re-validated envelope's JSON; the raw envelope when it does not validate. */
export function envelopeDigestOf(envelope: RecoveryEnvelope): string {
  const validated = validateRecoveryEnvelope(envelope);
  const canonical = validated.ok ? validated.value : envelope;
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export async function captureCandidate(
  port: RecoveryEnvelopePort,
  runId: string,
  handoverId: string,
  options: CaptureCandidateOptions
): Promise<CaptureCandidateResult> {
  const result = await port.captureAndPersistCandidateHandover(runId, handoverId, options);
  if (!result.ok) return { ok: false, code: 'capture-failed', diagnostic: result.code };
  return {
    ok: true,
    envelopeDigest: envelopeDigestOf(result.handover),
    coverage: result.handover.workspace.coverage,
    certainty: result.handover.effects.certainty
  };
}

export async function assessAttempt(
  port: RecoveryEnvelopePort,
  runId: string,
  handoverId: string
): Promise<AssessAttemptResult> {
  const read = await port.readRecoveryEnvelope(runId, handoverId);
  if (read === null) return { ok: false, code: 'context-missing' };
  if (!read.ok) {
    const newer = read.diagnostics.some((diagnostic) => diagnostic.code === NEWER_ENVELOPE_CODE);
    return { ok: false, code: newer ? 'unsupported-version' : 'context-invalid' };
  }
  return { ok: true, envelope: read.value, envelopeDigest: envelopeDigestOf(read.value) };
}
