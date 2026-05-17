// Barrel re-export for the phase-log host service module.
//
// The full module surface (path resolver, iteration discovery, JSONL
// parser, display projector, body truncator, manifest reader, tail
// session + registry, verbose-diagnostics detector) is wired up across
// Phases 3 and 4 of feature 020.

export type {
  PhaseLogSelection,
  IterationManifest,
  PhaseLogDisplayEntry,
  PhaseLogDisplayEntryKind,
  VerboseDiagnosticsBanner,
  PhaseLogReadResult,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from './types';

export { resolveStreamJsonlPath, resolvePhaseDirPath } from './phase-log-path';
export { discoverIterations } from './phase-log-iteration-discovery';
export { parseStreamJsonlBytes } from './phase-log-jsonl-parser';
export { projectStreamJsonlLine } from './phase-log-display-projector';
export { truncateDisplayEntryBody } from './phase-log-truncator';
export { detectVerboseDiagnosticsState } from './verbose-diagnostics-detector';
export { readIterationManifest, readPhaseLog } from './phase-log-reader';
export { createPhaseLogService } from './phase-log-service';
export type {
  PhaseLogService,
  PhaseLogServiceDeps,
  PhaseLogSnapshotView
} from './phase-log-service';
export { PhaseLogTailSession } from './phase-log-tail-session';
export type {
  PhaseLogTailSessionDeps,
  PhaseLogEntryPushPayload,
  TailEndedReason
} from './phase-log-tail-session';
export { PhaseLogTailRegistry } from './phase-log-tail-registry';
export type {
  PhaseLogTailRegistryDeps,
  PhaseLogTailRegistryAuditEvent,
  PhaseLogTailSubscriptionToken,
  PhaseLogTailEnvelope
} from './phase-log-tail-registry';
