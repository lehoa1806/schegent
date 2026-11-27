/**
 * Single authoritative classification of workspace `.schegent/` artifact classes
 * shared by `evidence-export.ts`, `evidence-delete.ts`, and
 * `tests/lint/retention-disclosure-parity.test.ts`.
 *
 * Run evidence export is strictly allowlist-driven: only explicitly eligible
 * artifact classes are ever copied, disclosed-omitted classes are skipped with
 * explicit omission reasons, and unknown paths under `.schegent/` are denied by
 * default rather than selected by `runId` substring matching.
 *
 * Zero `vscode` imports (keeps the artifact policy headless-testable).
 */
import * as path from 'node:path';
import { AUDIT_CUTS_BASENAME } from '../audit/audit-chain';
import { AUDIT_GENERATION_SIDECAR_NAME } from '../audit/audit-generation-sidecar';
import { FAILURE_RECORD_DIR, FAILURE_RECORD_NAME } from '../contracts/failure-record';
import { resolveRuntimeLogPath } from '../lib/runtime-log/runtime-log-path';
import { CLI_TRANSPORT_FILE_NAME } from '../monitor/cli-transport-sink';
import { TRANSPORT_RUN_FILE_NAME } from '../monitor/transport/transport-policy';
import { runIdFromDescriptionFile } from './history/history-description-store';

/** Phase-context handoff & ForEach staging/publication subtrees (F15-B; omitted on Run export, kept on delete). */
export const HANDOFF_SCHEGENT_SUBDIRS: ReadonlySet<string> = new Set([
  'results',
  'immutable-results',
  'handoff-materialized',
  'foreach-results'
]);

/** F05 artifact-lifecycle-managed external blobs & reports (omitted on Run export, kept on delete). */
export const EXTERNAL_ARTIFACT_SCHEGENT_SUBDIRS: ReadonlySet<string> = new Set([
  'transcripts',
  'diagnostics',
  'reports'
]);

/** Host operational state subtrees under `.schegent/` (`n/a` on Run export, kept on delete). */
export const HOST_STATE_SCHEGENT_SUBDIRS: ReadonlySet<string> = new Set([
  'catalog',
  'ownership',
  'telemetry',
  'sqlite'
]);

/**
 * FR-R7-14 (14-14) — Top-level `.schegent/` subtrees explicitly declared as `kept` in
 * `retentionDisclosure()` and `keptStores()` (F05 artifact-lifecycle blobs/reports, F15
 * handoff staging/materialized outputs, catalog, ownership leases, telemetry spool, and SQLite).
 * Shared between `evidence-delete.ts` and `evidence-export.ts` so both honor the same taxonomy.
 */
export const KEPT_SCHEGENT_SUBDIRS: ReadonlySet<string> = new Set([
  ...HANDOFF_SCHEGENT_SUBDIRS,
  ...EXTERNAL_ARTIFACT_SCHEGENT_SUBDIRS,
  ...HOST_STATE_SCHEGENT_SUBDIRS
]);

export type WorkspaceArtifactClass =
  | 'audit-log'
  | 'audit-cuts'
  | 'audit-generation-sidecar'
  | 'raw-session-transcript'
  | 'raw-session-transcript-pending'
  | 'run-diagnostics'
  | 'run-transport'
  | 'legacy-transport'
  | 'failure-record'
  | 'run-history-description'
  | 'metrics-rollup'
  | 'runtime-log'
  | 'host-state'
  | 'evidence-gitignore'
  | 'external-artifact'
  | 'phase-context-handoff'
  | 'lock-file'
  | 'unknown';

export type ExportDirectoryDecision =
  | { readonly kind: 'walk' }
  | { readonly kind: 'skip'; readonly artifactClass: WorkspaceArtifactClass }
  | { readonly kind: 'omit'; readonly artifactClass: WorkspaceArtifactClass; readonly reason: string }
  | { readonly kind: 'deny-unknown'; readonly reason: string };

export type ExportFileDecision =
  | {
      readonly kind: 'include-run';
      readonly artifactClass:
        | 'raw-session-transcript'
        | 'run-diagnostics'
        | 'run-transport'
        | 'failure-record'
        | 'run-history-description';
    }
  | { readonly kind: 'include-shared'; readonly artifactClass: 'audit-log' | 'audit-cuts' }
  | {
      readonly kind: 'omit';
      readonly artifactClass: WorkspaceArtifactClass;
      readonly reason: string;
    }
  | { readonly kind: 'skip'; readonly artifactClass: WorkspaceArtifactClass }
  | { readonly kind: 'deny-unknown'; readonly reason: string };

const PENDING_OMISSION_REASON =
  'in-flight spool directory: its contents are mid-write and would export a torn file';
const LOCK_OMISSION_REASON = 'lock file: it describes this machine, not the Run';
const HANDOFF_OMISSION_REASON =
  'phase-context handoff staging, immutable capture, or materialized copy: omitted from Run evidence export by retention disclosure policy';
const EXTERNAL_ARTIFACT_OMISSION_REASON =
  'artifact-lifecycle external blob or report: omitted from Run evidence export by retention disclosure policy';
const LEGACY_TRANSPORT_OMISSION_REASON =
  'legacy shared transport generation from an earlier release: omitted from single-Run evidence export';
const UNKNOWN_OMISSION_REASON =
  'unclassified path under .schegent/: Run evidence export includes only explicitly eligible artifact classes';

const DEFAULT_RUNTIME_LOG_BASENAME: string = (() => {
  const resolved = resolveRuntimeLogPath('', '<workspace>');
  if (!resolved.ok) throw new Error('evidence-artifact-policy: runtime log has no default location');
  return path.basename(resolved.path);
})();
const AUDIT_ROTATED_PATTERN = /^audit\.log\.[A-Za-z0-9._-]+$/;
const LEGACY_TRANSPORT_ROTATED_PATTERN = new RegExp(`^${escapeRegExp(CLI_TRANSPORT_FILE_NAME)}\\.\\d+$`);
const RUNTIME_LOG_PATTERN = new RegExp(`^${escapeRegExp(DEFAULT_RUNTIME_LOG_BASENAME)}(?:\\.\\d+)?$`);
const UUID_SUBSTRING_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const FAILURE_RECORDS_SUBDIR = FAILURE_RECORD_DIR[1];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split('\\').join('/').replace(/\/+$/, '');
}

/** True when `text` contains a Run UUID different from `runId` (prevents leaking sibling Run IDs). */
function containsOtherRunId(text: string, runId: string): boolean {
  const lowerRun = runId.toLowerCase();
  const matches = text.match(UUID_SUBSTRING_PATTERN);
  if (matches === null) return false;
  return matches.some((match) => match.toLowerCase() !== lowerRun);
}

/**
 * Classifies a directory under `.schegent/` during Run evidence export traversal.
 * Only explicitly eligible subtrees are walked; omitted subtrees stop at the subtree
 * boundary without reading contents or naming sibling Runs.
 */
export function classifyWorkspaceExportDirectory(
  relativeDir: string,
  runId: string
): ExportDirectoryDecision {
  const normalized = normalizeRelative(relativeDir);
  if (normalized === '.schegent') return { kind: 'walk' };
  if (!normalized.startsWith('.schegent/')) {
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }
  const parts = normalized.split('/');
  const top = parts[1] ?? '';
  const topLower = top.toLowerCase();

  if (parts.length === 2) {
    if (top === 'sessions' || top === FAILURE_RECORDS_SUBDIR || top === 'history') {
      return { kind: 'walk' };
    }
    if (HANDOFF_SCHEGENT_SUBDIRS.has(topLower)) {
      return { kind: 'omit', artifactClass: 'phase-context-handoff', reason: HANDOFF_OMISSION_REASON };
    }
    if (EXTERNAL_ARTIFACT_SCHEGENT_SUBDIRS.has(topLower)) {
      return { kind: 'omit', artifactClass: 'external-artifact', reason: EXTERNAL_ARTIFACT_OMISSION_REASON };
    }
    if (HOST_STATE_SCHEGENT_SUBDIRS.has(topLower)) {
      return { kind: 'skip', artifactClass: 'host-state' };
    }
    if (top === '.pending') {
      return { kind: 'omit', artifactClass: 'raw-session-transcript-pending', reason: PENDING_OMISSION_REASON };
    }
    if (top.endsWith('.lock')) {
      if (containsOtherRunId(normalized, runId)) return { kind: 'skip', artifactClass: 'lock-file' };
      return { kind: 'omit', artifactClass: 'lock-file', reason: LOCK_OMISSION_REASON };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  if (top === 'sessions') {
    const second = parts[2] ?? '';
    if (second === '.pending') {
      return { kind: 'omit', artifactClass: 'raw-session-transcript-pending', reason: PENDING_OMISSION_REASON };
    }
    if (second === runId) {
      // `.schegent/sessions/<runId>` and `.schegent/sessions/<runId>/diagnostics/**`
      if (parts.length === 3) return { kind: 'walk' };
      const third = parts[3] ?? '';
      if (third === 'diagnostics') return { kind: 'walk' };
      if (third === '.pending') {
        return { kind: 'omit', artifactClass: 'raw-session-transcript-pending', reason: PENDING_OMISSION_REASON };
      }
      if (third.endsWith('.lock')) {
        return { kind: 'omit', artifactClass: 'lock-file', reason: LOCK_OMISSION_REASON };
      }
      return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
    }
    // Another Run's session directory (or non-matching directory): never descend.
    return { kind: 'skip', artifactClass: 'run-diagnostics' };
  }

  // `failure-records` and `history` are flat directories; nested directories are not eligible evidence.
  if (top === FAILURE_RECORDS_SUBDIR || top === 'history') {
    const leaf = parts[parts.length - 1] ?? '';
    if (leaf === '.pending') {
      return { kind: 'omit', artifactClass: 'raw-session-transcript-pending', reason: PENDING_OMISSION_REASON };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  if (HANDOFF_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'omit', artifactClass: 'phase-context-handoff', reason: HANDOFF_OMISSION_REASON };
  }
  if (EXTERNAL_ARTIFACT_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'omit', artifactClass: 'external-artifact', reason: EXTERNAL_ARTIFACT_OMISSION_REASON };
  }
  if (HOST_STATE_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'skip', artifactClass: 'host-state' };
  }
  return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
}

/**
 * Classifies one file under `.schegent/` for Run evidence export.
 * Enforces explicit allowlisted artifact classes and denies unknown paths by default.
 */
export function classifyWorkspaceExportFile(
  relativePath: string,
  runId: string
): ExportFileDecision {
  const normalized = normalizeRelative(relativePath);
  if (!normalized.startsWith('.schegent/')) {
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }
  const parts = normalized.split('/');
  if (parts.length < 2) {
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }
  const top = parts[1] ?? '';
  const topLower = top.toLowerCase();
  const leaf = parts[parts.length - 1] ?? '';

  if (parts.includes('.pending')) {
    return { kind: 'omit', artifactClass: 'raw-session-transcript-pending', reason: PENDING_OMISSION_REASON };
  }
  if (leaf.endsWith('.lock')) {
    if (containsOtherRunId(normalized, runId)) return { kind: 'skip', artifactClass: 'lock-file' };
    return { kind: 'omit', artifactClass: 'lock-file', reason: LOCK_OMISSION_REASON };
  }

  // Top-level files directly under `.schegent/`
  if (parts.length === 2) {
    if (top === AUDIT_CUTS_BASENAME) {
      return { kind: 'include-shared', artifactClass: 'audit-cuts' };
    }
    if (top === 'audit.log' || AUDIT_ROTATED_PATTERN.test(top)) {
      return { kind: 'include-shared', artifactClass: 'audit-log' };
    }
    if (top === AUDIT_GENERATION_SIDECAR_NAME) {
      return { kind: 'skip', artifactClass: 'audit-generation-sidecar' };
    }
    if (top === CLI_TRANSPORT_FILE_NAME || LEGACY_TRANSPORT_ROTATED_PATTERN.test(top)) {
      return { kind: 'omit', artifactClass: 'legacy-transport', reason: LEGACY_TRANSPORT_OMISSION_REASON };
    }
    if (top === 'metrics-rollup.jsonl') {
      return { kind: 'skip', artifactClass: 'metrics-rollup' };
    }
    if (RUNTIME_LOG_PATTERN.test(top)) {
      return { kind: 'skip', artifactClass: 'runtime-log' };
    }
    if (top === '.gitignore') {
      return { kind: 'skip', artifactClass: 'evidence-gitignore' };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  // Disclosed omitted/kept top-level subtrees
  if (HANDOFF_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'omit', artifactClass: 'phase-context-handoff', reason: HANDOFF_OMISSION_REASON };
  }
  if (EXTERNAL_ARTIFACT_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'omit', artifactClass: 'external-artifact', reason: EXTERNAL_ARTIFACT_OMISSION_REASON };
  }
  if (HOST_STATE_SCHEGENT_SUBDIRS.has(topLower)) {
    return { kind: 'skip', artifactClass: 'host-state' };
  }

  // `.schegent/sessions/...`
  if (top === 'sessions') {
    if (parts.length === 3) {
      const file = parts[2] ?? '';
      if (file === `raw-${runId}.log`) {
        return { kind: 'include-run', artifactClass: 'raw-session-transcript' };
      }
      if (/^raw-.+\.log$/.test(file)) {
        // Another Run's raw transcript.
        return { kind: 'skip', artifactClass: 'raw-session-transcript' };
      }
      return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
    }
    const dirRun = parts[2] ?? '';
    if (dirRun !== runId) {
      return { kind: 'skip', artifactClass: 'run-diagnostics' };
    }
    if (parts.length === 4 && parts[3] === TRANSPORT_RUN_FILE_NAME) {
      return { kind: 'include-run', artifactClass: 'run-transport' };
    }
    if (parts.length >= 5 && parts[3] === 'diagnostics') {
      return { kind: 'include-run', artifactClass: 'run-diagnostics' };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  // `.schegent/failure-records/<stamp>_<suffix>_<runId>_<taskId>.json`
  if (top === FAILURE_RECORDS_SUBDIR && parts.length === 3) {
    const match = FAILURE_RECORD_NAME.exec(leaf);
    if (match !== null) {
      return match[3] === runId
        ? { kind: 'include-run', artifactClass: 'failure-record' }
        : { kind: 'skip', artifactClass: 'failure-record' };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  // `.schegent/history/<runId>.txt`
  if (top === 'history' && parts.length === 3) {
    const fileRunId = runIdFromDescriptionFile(leaf);
    if (fileRunId !== null) {
      return fileRunId === runId
        ? { kind: 'include-run', artifactClass: 'run-history-description' }
        : { kind: 'skip', artifactClass: 'run-history-description' };
    }
    return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
  }

  return { kind: 'deny-unknown', reason: UNKNOWN_OMISSION_REASON };
}

/**
 * Executable mapping from a workspace `.schegent/` disclosure location pattern
 * (as published in `retentionDisclosure()`) to the export disposition enforced by
 * `classifyWorkspaceExportFile`. Used by `retention-disclosure-parity.test.ts` to
 * keep the retention disclosure table and the exporter permanently in lockstep.
 */
export function exportDispositionForWorkspaceLocation(
  locationToken: string,
  sampleRunId: string
): 'included' | 'included whole (shared)' | 'omitted' | 'n/a' {
  const samplePath = locationToken
    .replaceAll('<runId>', sampleRunId)
    .replaceAll('<rootAlias>', sampleRunId)
    .replaceAll('<attemptAlias>', 'attempt-0001')
    .replaceAll('<stamp>', '20261127T000000Z')
    .replaceAll('<n>', '1')
    .replaceAll('<pipeline>', 'default')
    .replaceAll('<phase>', 'implement')
    .replaceAll('<iteration>', 'iter-1')
    .replaceAll('<record>', `20261127T000000000Z_deadbeef_${sampleRunId}_11111111-1111-4111-8111-111111111111.json`)
    .replaceAll('<description>', `${sampleRunId}.txt`)
    .replaceAll('<entry>', 'v1.json')
    .replaceAll('<artifact>', `${sampleRunId}.log`)
    .replaceAll('<file>', 'contribution.json');

  const decision = classifyWorkspaceExportFile(samplePath, sampleRunId);
  switch (decision.kind) {
    case 'include-run':
      return 'included';
    case 'include-shared':
      return 'included whole (shared)';
    case 'omit':
      return 'omitted';
    case 'skip':
      return 'n/a';
    case 'deny-unknown':
      throw new Error(`Disclosed workspace location '${locationToken}' (sample '${samplePath}') is unclassified by evidence-artifact-policy`);
  }
}

