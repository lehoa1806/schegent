/**
 * FR-R6-F04 (F04-B) — Domain store adapter contracts for Round 6 consumers:
 * F05 (Artifacts & Pins), F06 (Usage & Accounting), F07 (Log Segment Index),
 * F08 (Recovery Manifests), F10 (Execution Workspaces & Snapshots),
 * F11 (Reporting, Keyset Pagination & Leases), F13 (Agent Runtime Sessions,
 * Turns, Protocol Receipts, Effects & Projections), F14 (Telemetry Export &
 * Cardinality), and F15 (Accepted Results, Handoffs & Review Loops).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

// ---------------------------------------------------------------------------
// F05 — Artifacts, Locations, Availability, Lineage Relations & Single-Owner Pins
// ---------------------------------------------------------------------------

export interface ArtifactRow {
  readonly artifactId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly kind: string;
  readonly createdByRunId: string | null;
  readonly createdByAttemptId: string | null;
  readonly createdAtMs: number;
}

export interface ArtifactLocationRow {
  readonly locationId: string;
  readonly artifactId: string;
  readonly storageTier: 'inline_db' | 'cas_blob' | 'workspace_file';
  readonly uriOrRelpath: string;
  readonly inlineBytes: Uint8Array | null;
  readonly verifiedAtMs: number;
}

export interface ArtifactAvailabilityRow {
  readonly artifactId: string;
  readonly state: 'available' | 'quarantined' | 'evicted' | 'missing';
  readonly lastVerifiedAtMs: number;
  readonly detailJson: string;
}

export interface ArtifactPinRow {
  readonly pinId: string;
  readonly artifactId: string;
  readonly ownerRunId: string | null;
  readonly ownerAttemptId: string | null;
  readonly ownerHandoffId: string | null;
  readonly ownerExportId: string | null;
  readonly reason: string;
  readonly pinnedAtMs: number;
  readonly expiresAtMs: number | null;
}

// ---------------------------------------------------------------------------
// F06 — Usage Observations, Corrections, Applications & Revisions
// ---------------------------------------------------------------------------

export interface UsageObservationRow {
  readonly observationId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costMicrodollars: number;
  readonly sourceKind: 'provider_exact' | 'parsed_footer' | 'estimated';
  readonly observedAtMs: number;
}

export interface UsageCorrectionRow {
  readonly correctionId: string;
  readonly observationId: string;
  readonly reason: string;
  readonly deltaInputTokens: number;
  readonly deltaOutputTokens: number;
  readonly deltaCostMicrodollars: number;
  readonly pricingVersion: string;
  readonly createdAtMs: number;
}

export interface AttemptUsageRevisionRow {
  readonly attemptId: string;
  readonly runId: string;
  readonly revision: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
  readonly totalCostMicrodollars: number;
  readonly completeness: 'exact' | 'partial' | 'estimated';
  readonly updatedAtMs: number;
}

// ---------------------------------------------------------------------------
// F07 — Bounded Log Stream, Segment Index & Backpressure Gaps
// ---------------------------------------------------------------------------

export interface LogStreamRow {
  readonly streamId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly channel: 'stdout' | 'stderr' | 'protocol' | 'diagnostic';
  readonly totalBytes: number;
  readonly segmentCount: number;
  readonly closed: 0 | 1;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LogSegmentRow {
  readonly segmentId: string;
  readonly streamId: string;
  readonly segmentSeq: number;
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly lineCount: number;
  readonly contentSha256: string;
  readonly relativePath: string;
  readonly createdAtMs: number;
}

export interface LogGapRow {
  readonly gapId: string;
  readonly streamId: string;
  readonly afterSegmentSeq: number;
  readonly droppedBytes: number;
  readonly reason: 'backpressure' | 'truncation' | 'crash_recovery';
  readonly recordedAtMs: number;
}

// ---------------------------------------------------------------------------
// F08 — Crash Recovery Manifests & Verified Sources
// ---------------------------------------------------------------------------

export interface RecoveryManifestRow {
  readonly manifestId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly attemptId: string | null;
  readonly frozenClosureId: string | null;
  readonly classification: 'resumable' | 'reconcilable' | 'stranded' | 'terminal_verified';
  readonly actionTaken: string;
  readonly createdAtMs: number;
}

export interface RecoverySourceRow {
  readonly sourceId: string;
  readonly manifestId: string;
  readonly sourceKind: 'sqlite_row' | 'log_segment' | 'artifact_blob' | 'workspace_tree' | 'process_probe';
  readonly sourceRef: string;
  readonly digestSha256: string;
  readonly verified: 0 | 1;
}

// ---------------------------------------------------------------------------
// F10 — Execution Workspaces, Candidate Snapshots & Integration Receipts
// ---------------------------------------------------------------------------

export interface ExecutionWorkspaceRow {
  readonly executionWorkspaceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly strategy: 'worktree' | 'clone' | 'in_place';
  readonly rootRelpath: string;
  readonly baseCommitSha: string;
  readonly headCommitSha: string;
  readonly state: 'active' | 'snapshot_ready' | 'integrated' | 'abandoned' | 'cleaned';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CandidateSnapshotRow {
  readonly snapshotId: string;
  readonly executionWorkspaceId: string;
  readonly treeSha: string;
  readonly commitSha: string;
  readonly dirtyFileCount: number;
  readonly diffArtifactId: string | null;
  readonly createdAtMs: number;
}

export interface IntegrationReceiptRow {
  readonly receiptId: string;
  readonly executionWorkspaceId: string;
  readonly snapshotId: string;
  readonly targetBranch: string;
  readonly integratedCommitSha: string | null;
  readonly status: 'merged' | 'fast_forwarded' | 'conflict' | 'rejected';
  readonly recordedAtMs: number;
}

// ---------------------------------------------------------------------------
// F11 — Reporting Projections, Keyset Pagination at Cutoff S & Export Leases
// ---------------------------------------------------------------------------

export interface ExecutionSummaryRevisionRow {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly status: string;
  readonly revision: number;
  readonly stepCount: number;
  readonly completedStepCount: number;
  readonly attemptCount: number;
  readonly openFindingCount: number;
  readonly totalTokens: number;
  readonly totalCostMicrodollars: number;
  readonly durationMs: number;
  readonly startedAtMs: number | null;
  readonly updatedAtMs: number;
}

export interface AggregateRevisionRow {
  readonly scopeKey: string;
  readonly revision: number;
  readonly runCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly totalTokens: number;
  readonly totalCostMicrodollars: number;
  readonly updatedAtMs: number;
}

export interface KeysetCursor {
  readonly cutoffRevision: number;
  readonly lastUpdatedAtMs: number;
  readonly lastRunId: string;
}

export interface KeysetPageRequest {
  readonly workspaceId: string;
  readonly cutoffRevision: number;
  readonly pageSize: number;
  readonly cursor?: KeysetCursor | undefined;
  readonly statusFilter?: string | undefined;
}

export interface KeysetPageResult<T> {
  readonly items: readonly T[];
  readonly cutoffRevision: number;
  readonly nextCursor: KeysetCursor | null;
}

export interface ReportManifestRow {
  readonly reportId: string;
  readonly scopeKey: string;
  readonly cutoffRevision: number;
  readonly format: 'json' | 'markdown' | 'csv' | 'bundle';
  readonly artifactId: string | null;
  readonly createdAtMs: number;
}

export interface ReportLeaseRow {
  readonly leaseId: string;
  readonly reportId: string;
  readonly holderId: string;
  readonly cutoffRevision: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly status: 'active' | 'released' | 'expired';
}

export interface ExportOperationRow {
  readonly exportId: string;
  readonly reportId: string;
  readonly destinationRelpath: string;
  readonly status: 'completed' | 'pending' | 'failed' | 'cancelled';
  readonly byteLength: number;
  readonly contentSha256: string | null;
  readonly completedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// F13 — Agent Runtime Profiles, Sessions, Turns, Protocol Receipts & Effects
// ---------------------------------------------------------------------------

export interface AgentProfileRow {
  readonly profileId: string;
  readonly name: string;
  readonly provider: string;
  readonly adapterKind: 'cli' | 'acp' | 'sdk' | 'cloud';
  readonly activeVersionId: string | null;
  readonly createdAtMs: number;
}

export interface AgentProfileVersionRow {
  readonly profileVersionId: string;
  readonly profileId: string;
  readonly versionNumber: number;
  readonly configJson: string;
  readonly configSha256: string;
  readonly createdAtMs: number;
}

export interface AgentSessionRow {
  readonly agentSessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly profileVersionId: string;
  readonly state: 'initializing' | 'active' | 'suspended' | 'completed' | 'failed' | 'terminated';
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProviderSessionRow {
  readonly providerSessionId: string;
  readonly provider: string;
  readonly externalSessionRef: string;
  readonly capabilitiesJson: string;
  readonly createdAtMs: number;
}

export interface AgentConnectionRow {
  readonly connectionId: string;
  readonly transportKind: 'stdio' | 'socket' | 'http' | 'in_proc';
  readonly state: 'connected' | 'disconnected' | 'draining' | 'failed';
  readonly pid: number | null;
  readonly connectedAtMs: number;
  readonly disconnectedAtMs: number | null;
}

export interface AgentTurnRow {
  readonly turnId: string;
  readonly agentSessionId: string;
  readonly turnIndex: number;
  readonly state: 'queued' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  readonly promptArtifactId: string | null;
  readonly responseArtifactId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface ProtocolReceiptRow {
  readonly receiptId: string;
  readonly agentSessionId: string;
  readonly turnId: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly messageType: string;
  readonly sequenceNo: number;
  readonly payloadSha256: string;
  readonly recordedAtMs: number;
}

export interface EffectIntentRow {
  readonly effectIntentId: string;
  readonly agentSessionId: string;
  readonly turnId: string;
  readonly effectKind: 'file_write' | 'command_exec' | 'git_op' | 'network_call' | 'tool_call';
  readonly idempotencyKey: string;
  readonly targetSummary: string;
  readonly status: 'declared' | 'approved' | 'denied' | 'executed' | 'failed';
  readonly createdAtMs: number;
}

export interface EffectObservationRow {
  readonly observationId: string;
  readonly effectIntentId: string;
  readonly outcome: 'succeeded' | 'failed' | 'aborted';
  readonly exitCode: number | null;
  readonly artifactId: string | null;
  readonly observedAtMs: number;
}

export interface ProjectionIntentRow {
  readonly projectionId: string;
  readonly agentSessionId: string;
  readonly sourceRevision: number;
  readonly targetSurface: 'webview' | 'status_bar' | 'notification' | 'log_view';
  readonly payloadJson: string;
  readonly status: 'dispatched' | 'pending' | 'superseded' | 'dropped';
  readonly createdAtMs: number;
}

// ---------------------------------------------------------------------------
// F14 — Telemetry Destinations, Export Copies, Receipts & Cardinality Sets
// ---------------------------------------------------------------------------

export interface TelemetryDestinationRow {
  readonly destinationId: string;
  readonly kind: 'otlp_http' | 'jsonl_file' | 'memory_ring';
  readonly endpointOrPath: string;
  readonly enabled: 0 | 1;
  readonly createdAtMs: number;
}

export interface TelemetryExportCopyRow {
  readonly copyId: string;
  readonly destinationId: string;
  readonly sourceCommitUnit: string;
  readonly sourceRevision: number;
  readonly payloadJson: string;
  readonly payloadBytes: number;
  readonly status: 'queued' | 'sent' | 'failed' | 'dead_letter';
  readonly retryCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TelemetryDeliveryReceiptRow {
  readonly deliveryId: string;
  readonly copyId: string;
  readonly destinationId: string;
  readonly statusCode: number;
  readonly deliveredAtMs: number;
  readonly diagnosticText: string;
}

export interface TelemetryCardinalitySetRow {
  readonly metricFamily: string;
  readonly attributeKey: string;
  readonly attributeValue: string;
  readonly firstSeenAtMs: number;
}

// ---------------------------------------------------------------------------
// F15 — Accepted Results, Handoffs, Envelopes & Review Loops
// ---------------------------------------------------------------------------

export interface AcceptedResultRow {
  readonly resultId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly schemaId: string;
  readonly revision: number;
  readonly status: 'accepted' | 'superseded' | 'invalidated';
  readonly acceptedAtMs: number;
}

export interface HandoffRow {
  readonly handoffId: string;
  readonly runId: string;
  readonly fromStepId: string;
  readonly toStepId: string;
  readonly revision: number;
  readonly status: 'prepared' | 'approved' | 'delivered' | 'consumed' | 'rejected' | 'expired';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ReviewLoopRow {
  readonly reviewLoopId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly status: 'open' | 'converged' | 'escalated' | 'aborted';
  readonly revision: number;
  readonly updatedAtMs: number;
}

export interface FindingRow {
  readonly findingId: string;
  readonly reviewLoopId: string;
  readonly reportId: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly category: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly summary: string;
  readonly status: 'open' | 'claimed' | 'fixed' | 'waived' | 'false_positive';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
