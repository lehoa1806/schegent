/**
 * FR-R6-F08 (FR-003) — the one recovery handoff service.
 *
 * It composes the handoff store, the F05 pins and resolver, and the recovery envelope port. No
 * production code constructs it in this feature; F01-B composes it.
 *
 * Every operation returns `{ ok: true, ... }` or `{ ok: false, code, ... }` for an expected
 * outcome and never throws for one. The service writes no log lines: every outcome is a row or a
 * returned value.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  HANDOFF_MANIFEST_VERSION,
  type HandoffCutoff,
  type HandoffDecision,
  type HandoffLineage,
  type HandoffOwnerResolution,
  type HandoffRefusal
} from '../../contracts/recovery-handoff/handoff-types';
import type { AcpSessionBindingStore } from '../acp-runtime/acp-durable-runtime-store';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { ArtifactRecordStore, type ArtifactByteProbe } from '../artifact-lifecycle/artifact-records';
import type { NodeSqliteConnection } from '../sqlite-store';
import {
  assessAttempt,
  captureCandidate,
  type AssessAttemptResult,
  type CaptureCandidateOptions,
  type CaptureCandidateResult,
  type RecoveryEnvelopePort
} from './handoff-envelopes';
import { recordIntent, type RecordIntentInput, type RecordIntentResult } from './handoff-intent';
import {
  decideHandoff,
  explainHandoff,
  setHandoffPaused,
  supersedeHandoff,
  type DecideResult,
  type ExplainResult,
  type SetPausedResult,
  type SupersedeResult
} from './handoff-operator';
import { handoffOwnerResolution, isNewerBuildStore } from './handoff-pins';
import { issueRevision, prepareRevision, type HandoffWriteDeps, type IssueResult, type PrepareResult } from './handoff-prepare';
import {
  resolveRevision,
  type EnvelopeVerificationLocation,
  type RevisionResolution
} from './handoff-resolver';
import {
  acknowledgeIntent,
  consumeHandoff,
  reopenHandoffs,
  reportIntentNotSent,
  type AcknowledgeResult,
  type ConsumeResult,
  type ReopenResult,
  type ReportNotSentResult
} from './handoff-settle';
import { createHandoffStore } from './handoff-store';
import { importLegacyRecord, type ImportLegacyResult } from './legacy-handoff-import';
import type { LegacyHandoffRecord } from './legacy-handoff-mapping';

export interface RecoveryHandoffServiceDeps {
  /** Bootstrapped through migration 5. */
  readonly conn: NodeSqliteConnection;
  readonly lifecycle: ArtifactLifecycleService;
  readonly probe: Pick<ArtifactByteProbe, 'digestSha256'> & Partial<Pick<ArtifactByteProbe, 'observe'>>;
  readonly envelopes: RecoveryEnvelopePort;
  /** Optional durable ACP session binding store for cross-checking legacy-to-ACP mappings (`16-12`). */
  readonly acpSessionBindings?: AcpSessionBindingStore;
  /** Epoch ms. */
  readonly clock: () => number;
}

export interface VerifyForUseOptions {
  readonly revisionNo?: number;
  readonly envelopeLocation?: EnvelopeVerificationLocation;
}

export type ResolveResult =
  | ({ readonly ok: true } & RevisionResolution)
  | HandoffRefusal<'not-found' | 'unsupported-version'>;

export interface RecoveryHandoffService {
  captureCandidate(runId: string, handoverId: string, options: CaptureCandidateOptions): Promise<CaptureCandidateResult>;
  assessAttempt(runId: string, handoverId: string): Promise<AssessAttemptResult>;
  prepare(lineage: HandoffLineage, cutoff: HandoffCutoff, manifest: unknown, legacyProvenance?: string): PrepareResult;
  issue(handoffId: string, revisionNo: number): IssueResult;
  /** Resolves the given revision, else the current one, with fresh byte/digest probing. */
  resolve(handoffId: string, revisionNo?: number): Promise<ResolveResult>;
  /** Freshly verifies artifact and envelope bytes/digests at use regardless of cached metadata (`16-12`). */
  verifyForUse(handoffId: string, options?: VerifyForUseOptions): Promise<ResolveResult>;
  ownerResolution(handoffId: string): HandoffOwnerResolution;
  recordIntent(input: RecordIntentInput): RecordIntentResult;
  acknowledge(intentId: string): AcknowledgeResult;
  reportNotSent(intentId: string): ReportNotSentResult;
  consume(handoffId: string): ConsumeResult;
  /** Run once at startup: pending intents become uncertain, then pins are reconciled. */
  reopen(): ReopenResult;
  /** Records an operator decision against the revision the operator read. */
  decide(handoffId: string, revisionNo: number, decision: HandoffDecision, requestId: string): DecideResult;
  setHandoffPaused(handoffId: string, paused: boolean): SetPausedResult;
  supersede(handoffId: string): SupersedeResult;
  /** Reads the handoff's rows and writes none. */
  explain(handoffId: string): ExplainResult;
  /** Maps a pre-cutover record and prepares it, or stores it `unsupported` (R11). */
  importLegacy(record: LegacyHandoffRecord): ImportLegacyResult;
}

export function createRecoveryHandoffService(deps: RecoveryHandoffServiceDeps): RecoveryHandoffService {
  const store = createHandoffStore(deps.conn);
  const records = new ArtifactRecordStore(deps.conn, deps.clock);
  const writes: HandoffWriteDeps = {
    conn: deps.conn,
    store,
    lifecycle: deps.lifecycle,
    ...(deps.acpSessionBindings !== undefined ? { acpSessionBindings: deps.acpSessionBindings } : {}),
    nowMs: deps.clock
  };
  const resolverDeps = {
    store,
    lifecycle: deps.lifecycle,
    locatorOf: (artifactId: string) => records.locatorOf(artifactId),
    probe: deps.probe,
    envelopes: deps.envelopes,
    nowMs: deps.clock
  };

  async function resolveWithOptions(
    handoffId: string,
    options?: VerifyForUseOptions,
    requireEnvelope = false
  ): Promise<ResolveResult> {
    if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
    const handoff = store.getHandoff(handoffId);
    if (handoff === undefined) return { ok: false, code: 'not-found' };
    if (handoff.state === 'unsupported') return { ok: false, code: 'unsupported-version' };
    const target = options?.revisionNo ?? handoff.currentRevision;
    const revision = target === null ? undefined : store.getRevision(handoffId, target);
    if (target === null || revision === undefined) return { ok: false, code: 'not-found' };
    // A revision a newer build wrote is kept as it is and never consumed (FR-015).
    if (revision.manifestVersion > HANDOFF_MANIFEST_VERSION) return { ok: false, code: 'unsupported-version' };
    return {
      ok: true,
      ...(await resolveRevision(resolverDeps, handoffId, target, {
        ...(options?.envelopeLocation !== undefined ? { envelopeLocation: options.envelopeLocation } : {}),
        requireEnvelope
      }))
    };
  }

  return {
    captureCandidate: (runId, handoverId, options) => captureCandidate(deps.envelopes, runId, handoverId, options),
    assessAttempt: (runId, handoverId) => assessAttempt(deps.envelopes, runId, handoverId),
    prepare: (lineage, cutoff, manifest, legacyProvenance) =>
      prepareRevision(writes, lineage, cutoff, manifest, legacyProvenance),
    issue: (handoffId, revisionNo) => issueRevision(writes, handoffId, revisionNo),
    resolve: (handoffId, revisionNo) =>
      resolveWithOptions(handoffId, revisionNo === undefined ? undefined : { revisionNo }, false),
    verifyForUse: (handoffId, options) => resolveWithOptions(handoffId, options, true),
    ownerResolution: (handoffId) => handoffOwnerResolution(deps.conn, handoffId),
    recordIntent: (input) => recordIntent(writes, input),
    acknowledge: (intentId) => acknowledgeIntent(writes, intentId),
    reportNotSent: (intentId) => reportIntentNotSent(writes, intentId),
    consume: (handoffId) => consumeHandoff(writes, handoffId),
    reopen: () => reopenHandoffs(writes),
    decide: (handoffId, revisionNo, decision, requestId) =>
      decideHandoff(writes, handoffId, revisionNo, decision, requestId),
    setHandoffPaused: (handoffId, paused) => setHandoffPaused(writes, handoffId, paused),
    supersede: (handoffId) => supersedeHandoff(writes, handoffId),
    explain: (handoffId) => explainHandoff(writes, handoffId),
    importLegacy: (record) => importLegacyRecord(writes, record)
  };
}
