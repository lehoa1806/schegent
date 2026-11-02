// FR-R3-085 (PRIV-01) — what is kept, where, for how long, DERIVED from the
// constants that enforce it.
//
// WHY DERIVED AND NOT WRITTEN
//
// This exact class has recurred three times in this round: operator-facing text
// asserting a property nothing checks (`R-14`), a manifest promising a record the
// contract did not declare (`D2`), and a document describing a product that had
// changed underneath it (`F-08`). Each time the fix was an edit, and each time
// the text drifted again.
//
// So every bound below is READ from the constant that enforces it. There is no
// second number to keep in step, and `tests/lint/retention-disclosure-parity.test.ts`
// fails if the rendered document and these constants disagree.
//
// FR-R4-F04 (FR-009, FR-030, FR-032; N1 to N4) — AN INVENTORY, NOT A SAMPLE. The table used to list nine
// stores while the product wrote more, and nothing compared the two. It now lists every store the product
// writes, with the facts an operator needs about each: its content class, how it is swept, what protects a
// live Run's files, and what Delete and Export do with it. `tests/unit/services/retention-inventory.test.ts`
// drives the real writers and fails on any file no row's `location` claims.
//
// WHAT THIS DOES NOT CHANGE. Errors-only remains the default capture posture.
// This describes what is retained; it does not alter what is captured.
import {
  AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS,
  AUDIT_ARCHIVE_DEFAULT_MAX_COUNT,
  AUDIT_ROTATION_DEFAULT_AGE_MS,
  AUDIT_ROTATION_DEFAULT_SIZE_BYTES
} from '../audit/audit-log-writer';
import { AUDIT_CUTS_BASENAME } from '../audit/audit-chain';
import { AUDIT_GENERATION_SIDECAR_NAME } from '../audit/audit-generation-sidecar';
import { AUDIT_PAYLOAD_MAX_BYTES } from '../audit/audit-payload';
import * as path from 'node:path';

import { SETTINGS_SCHEMA } from '../config/settings-schema';
import { CATALOG_RETENTION_BOUND } from '../contracts/catalog-store';
import { FAILURE_RECORD_DIR, FAILURE_RECORD_MAX_BYTES, FAILURE_RECORD_RETAINED_MAX } from '../contracts/failure-record';
import { MONITOR_STALL_THRESHOLD_MS } from '../contracts/monitor-events';
import { MAX_ARTIFACT_BYTES } from './evidence-export';
import { HISTORY_DESCRIPTION_DIR, HISTORY_ORPHAN_GRACE_MS, HISTORY_SWEEP_MAX_REMOVALS } from './history/history-description-store';
import { resolveRuntimeLogPath } from '../lib/runtime-log/runtime-log-path';
import { CLI_TRANSPORT_FILE_NAME, CLI_TRANSPORT_MAX_GENERATIONS } from '../monitor/cli-transport-sink';
import { RETAINED_RECORDS_AFTER_TRIM, TRIM_THRESHOLD_BYTES } from '../metrics/metrics-rollup-writer';
import {
  TRANSPORT_FILE_MAX_BYTES,
  TRANSPORT_RUN_FILE_NAME,
  TRANSPORT_SPOOL_PREFIX,
  TRANSPORT_WORKSPACE_MAX_BYTES
} from '../monitor/transport/transport-policy';
import { HISTORY_CAP_PER_QUEUE } from '../state/workspace-state';
import {
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_MAX_TOTAL_BYTES,
  CHECKPOINT_RECENT_RUN_FLOOR
} from './run-checkpoint-retention';
import { RUN_CHECKPOINT_DIRECTORY } from './run-checkpoint-paths';

export type RetentionContentClass = 'unredacted content' | 'redacted content' | 'metadata' | 'state' | 'recovery material';
export type RetentionSweep = 'append' | 'rotation' | 'run-end' | 'activation' | 'settings-change' | 'periodic' | 'none';
export type RetentionOnDelete = 'removed' | 'kept' | 'kept (Run history)' | 'n/a';
export type RetentionOnExport = 'included' | 'included whole (shared)' | 'omitted' | 'n/a';

/** One store the product writes (data-model §11). */
export interface RetentionInventoryRow {
  /** What is held. */
  readonly store: string;
  /** One or more whitespace-separated path patterns, never a resolved path; `<name>` stands for one segment. */
  readonly location: string;
  readonly contentClass: RetentionContentClass;
  /** Whether its CONTENT is redacted. The raw transcript and the recovery checkpoint deliberately are not. */
  readonly redacted: boolean;
  /** The bound, in the words a reader needs, built from imported constants and settings keys. */
  readonly bounds: string;
  readonly sweptBy: readonly RetentionSweep[];
  /** What keeps a live Run's files out of a sweep. */
  readonly liveProtection: string;
  readonly onDelete: RetentionOnDelete;
  readonly onExport: RetentionOnExport;
  /** The constant, module or settings key the bound came from, so a reader can check it. */
  readonly source: string;
}

const MIB = 1024 * 1024;
/**
 * The raw spool directory's name prefix. Written here and not imported: the plan leaves `raw-transcript-writer.ts`
 * untouched (the transcript's lifetime is unchanged), and `retention-inventory.test.ts` drives the real writer and
 * fails on a spool path this prefix does not claim, so a rename there shows up as a mismatch, not as drift.
 */
const RAW_SPOOL_PREFIX = 'schegent-raw-spool-';
const days = (ms: number): number => Math.round(ms / 86_400_000);
const hours = (ms: number): number => Math.round(ms / 3_600_000);
const mib = (bytes: number): number => Math.round(bytes / MIB);
const kib = (bytes: number): number => Math.round(bytes / 1024);
const count = (value: number): string => value.toLocaleString('en-US');

/** A settings default, read from the schema that `package.json` is checked against. */
function settingDefault(key: string): number {
  const entry = Object.values(SETTINGS_SCHEMA).find((candidate) => candidate.key === key);
  if (entry === undefined || typeof entry.default !== 'number') throw new Error(`retention inventory: no numeric default for ${key}`);
  return entry.default;
}

/**
 * The runtime log's default location, read from the module that resolves it (an empty `runtimeLogFilePath`),
 * relative to the workspace. Derived and not typed: this module writes nothing there, and a second spelling of
 * the file name is one more place for it to drift from the sink's.
 */
const RUNTIME_LOG_DEFAULT: string = (() => {
  const label = '<workspace>';
  const resolved = resolveRuntimeLogPath('', label);
  if (!resolved.ok) throw new Error('retention inventory: the runtime log has no default location');
  return path.relative(label, resolved.path).split(path.sep).join('/');
})();

const SESSION_AGE_DAYS = settingDefault('schegent.logging.sessionRetentionMaxAgeDays');
const SESSION_MAX_MIB = mib(settingDefault('schegent.logging.sessionRetentionMaxBytes'));
const RUNTIME_LOG_MAX_MIB = mib(settingDefault('schegent.logging.runtimeLogMaxBytes'));
const RUNTIME_LOG_GENERATIONS = settingDefault('schegent.logging.runtimeLogMaxGenerations');

const SESSION_SETTINGS = 'schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes';
const SESSION_BOUND =
  `by the session retention settings (default ${SESSION_AGE_DAYS} days and ${SESSION_MAX_MIB} MiB), ` +
  'whichever removes it first';
const ACTIVE_RUN_PROTECTION = 'a Run that is executing or paused is never selected';

/**
 * The disclosure, as data. Rendering is separate so the same facts can reach a
 * document, a command and a test without three copies of them.
 */
export function retentionDisclosure(): readonly RetentionInventoryRow[] {
  return Object.freeze([
    {
      store: 'Structured audit log',
      location: '.schegent/audit.log .schegent/audit.log.<stamp>',
      contentClass: 'metadata',
      redacted: true,
      bounds:
        `rotates at ${mib(AUDIT_ROTATION_DEFAULT_SIZE_BYTES)} MiB or ${days(AUDIT_ROTATION_DEFAULT_AGE_MS)} days ` +
        "(age measured from the generation's oldest usable row), whichever comes first; at most " +
        `${AUDIT_ARCHIVE_DEFAULT_MAX_COUNT} archives are kept, each at most ${days(AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS)} days; ` +
        `each payload is truncated above ${kib(AUDIT_PAYLOAD_MAX_BYTES)} KiB`,
      sweptBy: ['rotation', 'activation'],
      liveProtection: 'the live log is never pruned; only rotated archives are, and each prune is recorded as a cut',
      onDelete: 'kept',
      onExport: 'included whole (shared)',
      source:
        'AUDIT_ROTATION_DEFAULT_SIZE_BYTES / AUDIT_ROTATION_DEFAULT_AGE_MS / AUDIT_ARCHIVE_DEFAULT_MAX_COUNT / AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS in src/audit/audit-log-writer.ts; AUDIT_PAYLOAD_MAX_BYTES in src/audit/audit-payload.ts'
    },
    {
      store: 'Audit cuts',
      location: `.schegent/${AUDIT_CUTS_BASENAME}`,
      contentClass: 'metadata',
      redacted: true,
      bounds: 'one small record appended each time an archive is pruned, so the chain verifier can tell a prune from a deletion; no bound of its own',
      sweptBy: ['none'],
      liveProtection: 'append-only; the writer never rewrites it',
      onDelete: 'kept',
      onExport: 'included whole (shared)',
      source: 'AUDIT_CUTS_BASENAME in src/audit/audit-chain.ts'
    },
    {
      // FR-R4-F03 (R19) — kept outside the workspace on purpose: removing `.schegent/` must not remove the
      // record that history existed. It holds a digest, a position and times, and no content.
      store: 'Audit head checkpoint',
      location: '<globalStorage>/audit-checkpoints/<key>.json',
      contentClass: 'metadata',
      redacted: true,
      bounds:
        'one small file per workspace location, holding a digest, a position and times only; never pruned, and retired only by the reset command; a moved folder leaves its old file behind',
      sweptBy: ['none'],
      liveProtection: 'replaced in place by the window that owns the workspace',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'checkpointKey in src/audit/audit-checkpoint.ts; the store in src/audit/audit-checkpoint-store.ts'
    },
    {
      store: 'Audit generation sidecar',
      location: `.schegent/${AUDIT_GENERATION_SIDECAR_NAME}`,
      contentClass: 'state',
      redacted: true,
      bounds: "one small file recording when the live audit generation was first observed, used to age a generation whose rows carry no usable time; no bound of its own",
      sweptBy: ['rotation'],
      liveProtection: 'keyed by the live generation, so a rotation starts a fresh record',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'AUDIT_GENERATION_SIDECAR_NAME in src/audit/audit-generation-sidecar.ts'
    },
    {
      // Stated plainly. This is the threat model's declared position, not an oversight, and it is the reason
      // an operator needs this disclosure at all.
      store: 'Raw session transcript (retained)',
      location: '.schegent/sessions/raw-<runId>.log',
      contentClass: 'unredacted content',
      redacted: false,
      bounds: `kept for \`always\`, or promoted for a non-clean Run under \`errors-only\`; removed ${SESSION_BOUND}`,
      sweptBy: ['run-end', 'activation', 'settings-change', 'periodic'],
      liveProtection: ACTIVE_RUN_PROTECTION,
      onDelete: 'removed',
      onExport: 'included',
      source: `src/audit/raw-transcript-writer.ts; ${SESSION_SETTINGS}`
    },
    {
      store: 'Raw session transcript (pending)',
      location: '.schegent/sessions/.pending/raw-<runId>.log',
      contentClass: 'unredacted content',
      redacted: false,
      bounds: `holds an \`errors-only\` Run's transcript until it ends: promoted to the retained name if the Run failed, was canceled or paused, removed if it completed; otherwise swept ${SESSION_BOUND}`,
      sweptBy: ['run-end', 'activation', 'settings-change', 'periodic'],
      liveProtection: ACTIVE_RUN_PROTECTION,
      onDelete: 'removed',
      onExport: 'omitted',
      source: `src/audit/raw-transcript-writer.ts; ${SESSION_SETTINGS}`
    },
    {
      store: 'Raw transcript spool',
      location: `<temp>/${RAW_SPOOL_PREFIX}<pid>-<suffix>/stdout <temp>/${RAW_SPOOL_PREFIX}<pid>-<suffix>/stderr`,
      contentClass: 'unredacted content',
      redacted: false,
      bounds: "the backend's output while one invocation runs, in the operating system's temporary area and outside the workspace; removed when the invocation ends, and a spool left by a process that has died is removed by the next writer's scavenge",
      sweptBy: ['run-end'],
      liveProtection: 'a spool is named for the process that made it, so a live process\'s spool is not reaped',
      onDelete: 'n/a',
      onExport: 'n/a',
      source: 'RAW_SPOOL_PREFIX in src/audit/raw-transcript-writer.ts (not exported; checked by tests/unit/services/retention-inventory.test.ts)'
    },
    {
      store: 'Run diagnostics trees',
      location: '.schegent/sessions/<runId>/diagnostics/<pipeline>/<phase>/<iteration>/<file>',
      contentClass: 'unredacted content',
      redacted: false,
      bounds: `the verbose diagnostic files (\`stream.jsonl\`, \`debug.json\`, \`verbose.log\`) of one phase iteration; ${SESSION_BOUND}`,
      sweptBy: ['run-end', 'activation', 'settings-change', 'periodic'],
      liveProtection: ACTIVE_RUN_PROTECTION,
      onDelete: 'removed',
      onExport: 'included',
      source: SESSION_SETTINGS
    },
    {
      // FR-R4-F04 (FR-009) — transport is per Run now: the Run file, the stage an `errors-only` Run waits in,
      // and the shared generations an earlier release left. Every number is read from the constant that
      // enforces it.
      store: 'Run transport (CLI stream lines)',
      location: `.schegent/sessions/<runId>/${TRANSPORT_RUN_FILE_NAME}`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `kept when the transport mode keeps it; at most ${mib(TRANSPORT_FILE_MAX_BYTES)} MiB per Run and ${mib(
        TRANSPORT_WORKSPACE_MAX_BYTES
      )} MiB across all Run files and legacy generations, with records older than the session retention age removed; secret patterns redacted, otherwise CLI content as sent`,
      sweptBy: ['append', 'run-end', 'periodic'],
      liveProtection: "the pass does not age an active Run's file, and the total is enforced without removing it",
      onDelete: 'removed',
      onExport: 'included',
      source:
        'TRANSPORT_FILE_MAX_BYTES / TRANSPORT_WORKSPACE_MAX_BYTES in src/monitor/transport/transport-policy.ts; schegent.logging.transportCaptureMode'
    },
    {
      store: 'Transport stage (errors-only, while a Run is active)',
      location: `<temp>/${TRANSPORT_SPOOL_PREFIX}<key>/<runId>.log`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `holds an \`errors-only\` Run's transport until it ends: promoted to its Run file if the Run failed or was canceled, removed if it completed; at most ${mib(
        TRANSPORT_FILE_MAX_BYTES
      )} MiB per Run, outside the workspace and outside the total`,
      sweptBy: ['run-end', 'periodic'],
      liveProtection: "a stage is promoted or removed only when its Run is known to have ended; while the Run runs it is only aged by the retention age",
      onDelete: 'n/a',
      onExport: 'n/a',
      source: 'TRANSPORT_FILE_MAX_BYTES / TRANSPORT_SPOOL_PREFIX in src/monitor/transport/transport-policy.ts'
    },
    {
      store: 'Legacy transport generations',
      location: `.schegent/${CLI_TRANSPORT_FILE_NAME} .schegent/${CLI_TRANSPORT_FILE_NAME}.<n>`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `no longer written (at most ${CLI_TRANSPORT_MAX_GENERATIONS} numbered generations from an earlier release); each file expires whole by its newest record at the session retention age, and counts toward the Run-transport total`,
      sweptBy: ['run-end', 'periodic'],
      liveProtection: 'no Run writes it, so there is nothing to protect',
      onDelete: 'kept',
      onExport: 'omitted',
      source: 'CLI_TRANSPORT_FILE_NAME / CLI_TRANSPORT_MAX_GENERATIONS in src/monitor/cli-transport-sink.ts'
    },
    {
      store: 'Failure records',
      location: `.schegent/${FAILURE_RECORD_DIR[1]}/<record>`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `one record per failed Run, at most ${kib(FAILURE_RECORD_MAX_BYTES)} KiB each; at most the newest ${FAILURE_RECORD_RETAINED_MAX} are kept, each for the session retention age (default ${SESSION_AGE_DAYS} days)`,
      sweptBy: ['run-end', 'activation', 'settings-change', 'periodic'],
      liveProtection: 'a record is written once and never rewritten',
      onDelete: 'removed',
      onExport: 'included',
      source: `FAILURE_RECORD_RETAINED_MAX / FAILURE_RECORD_MAX_BYTES in src/contracts/failure-record.ts; schegent.logging.sessionRetentionMaxAgeDays`
    },
    {
      store: 'Run history descriptions',
      location: `${HISTORY_DESCRIPTION_DIR.split('\\').join('/')}/<description>`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `the operator's description of a Run; a description no history entry refers to is removed once it is ${hours(HISTORY_ORPHAN_GRACE_MS)} hours old, at most ${HISTORY_SWEEP_MAX_REMOVALS} per activation`,
      sweptBy: ['activation'],
      liveProtection: `a description newer than ${hours(HISTORY_ORPHAN_GRACE_MS)} hours may still be mid-write and is kept`,
      onDelete: 'kept (Run history)',
      onExport: 'included',
      source: 'HISTORY_ORPHAN_GRACE_MS / HISTORY_SWEEP_MAX_REMOVALS in src/services/history/history-description-store.ts'
    },
    {
      // N2 — the rollup's text is the writer's own header, from the constants the trim uses.
      store: 'Metrics rollup',
      location: '.schegent/metrics-rollup.jsonl',
      contentClass: 'metadata',
      redacted: true,
      bounds: `one record per terminal Run; trimmed to the newest ${count(RETAINED_RECORDS_AFTER_TRIM)} records when it passes ${mib(
        TRIM_THRESHOLD_BYTES
      )} MiB; totals carried forward`,
      sweptBy: ['append'],
      liveProtection: 'appended once per Run id, at the terminal transition',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'TRIM_THRESHOLD_BYTES / RETAINED_RECORDS_AFTER_TRIM in src/metrics/metrics-rollup-writer.ts'
    },
    {
      // N3 (FR-032, R32) — a decision, with its reason: the path can be configured outside the workspace,
      // and an age sweep would delete files in a place the operator chose.
      store: 'Runtime log',
      location: `${RUNTIME_LOG_DEFAULT} ${RUNTIME_LOG_DEFAULT}.<n>`,
      contentClass: 'redacted content',
      redacted: true,
      bounds: `sanitized host diagnostics; rotates at ${RUNTIME_LOG_MAX_MIB} MiB and keeps ${RUNTIME_LOG_GENERATIONS} generations by default (the two \`schegent.logging.runtimeLog*\` settings); no age bound, by decision: its path can be configured outside the workspace, where an age sweep would delete files in a place you chose; default location`,
      sweptBy: ['rotation'],
      liveProtection: 'the live file is rotated, never deleted by a sweep',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'schegent.logging.runtimeLogMaxBytes / schegent.logging.runtimeLogMaxGenerations in src/config/settings-schema.ts'
    },
    {
      store: 'Ownership records',
      location: '.schegent/ownership/<record>',
      contentClass: 'state',
      redacted: true,
      bounds: "small records of which window holds the workspace; each is replaced in place by the window that owns it and removed when it is released; they hold no evidence content",
      sweptBy: ['none'],
      liveProtection: 'a record is changed only by its owner',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'src/state/ownership-fs.ts'
    },
    {
      store: 'Process catalog',
      location: '.schegent/catalog/<entry>',
      contentClass: 'state',
      redacted: true,
      bounds: `the saved process definitions; at most ${CATALOG_RETENTION_BOUND} versions are kept, and a version a Run or history entry refers to is not pruned`,
      sweptBy: ['append'],
      liveProtection: 'the active and draft versions and any version a Run refers to are exempt',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'CATALOG_RETENTION_BOUND in src/contracts/catalog-store.ts'
    },
    {
      store: 'Evidence .gitignore',
      location: '.schegent/.gitignore',
      contentClass: 'state',
      redacted: true,
      bounds: 'one small file that keeps this directory out of commits; created beside the first evidence written, never overwritten when an operator has changed it',
      sweptBy: ['none'],
      liveProtection: 'not applicable',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'src/audit/schegent-gitignore.ts'
    },
    {
      store: 'Private recovery checkpoints',
      location: `<globalStorage>/${RUN_CHECKPOINT_DIRECTORY}/<runId>/<file>`,
      contentClass: 'recovery material',
      redacted: false,
      bounds: `${days(CHECKPOINT_MAX_AGE_MS)} days and ${mib(
        CHECKPOINT_MAX_TOTAL_BYTES
      )} MiB total, with the ${CHECKPOINT_RECENT_RUN_FLOOR} most recent Run directories protected from the size limit; deliberately outside the workspace`,
      sweptBy: ['activation'],
      liveProtection: `the ${CHECKPOINT_RECENT_RUN_FLOOR} most recent Run directories are protected from the size limit`,
      onDelete: 'removed',
      onExport: 'n/a',
      source: 'CHECKPOINT_MAX_AGE_MS / CHECKPOINT_MAX_TOTAL_BYTES / CHECKPOINT_RECENT_RUN_FLOOR in src/services/run-checkpoint-retention.ts'
    },
    {
      store: 'Workspace memento state',
      location: '<workspaceState>/schegent.*',
      contentClass: 'state',
      redacted: true,
      bounds: `the Run map, queues and history that survive a reload; history is capped at ${HISTORY_CAP_PER_QUEUE} entries per queue, the oldest dropped first`,
      sweptBy: ['append'],
      liveProtection: 'the cap applies to history entries only',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'HISTORY_CAP_PER_QUEUE in src/state/workspace-state.ts'
    },
    {
      store: 'Operator pseudonym',
      location: '<workspaceState>/schegent.operatorPseudonym',
      contentClass: 'state',
      redacted: true,
      bounds: 'one random label of the form `pseudonym-` and 16 hex digits, made on first use and written into audit rows in place of an account name; replaced only by the reset command, which records the reset first',
      sweptBy: ['none'],
      liveProtection: 'not applicable',
      onDelete: 'kept',
      onExport: 'n/a',
      source: 'schegent.operatorPseudonym in src/state/workspace-state.ts; src/lib/operator-attribution.ts'
    },
    {
      store: 'Export, audit-export and bundle destinations',
      location: '<destination>/<export>',
      contentClass: 'redacted content',
      redacted: true,
      bounds: `a directory or file you choose; each artifact is carried up to ${mib(
        MAX_ARTIFACT_BYTES
      )} MiB and anything larger is omitted with the reason in the manifest; owner-only permissions; Schegent never removes or ages what it exported`,
      sweptBy: ['none'],
      liveProtection: 'not applicable: outside the workspace once written',
      onDelete: 'n/a',
      onExport: 'n/a',
      source: 'MAX_ARTIFACT_BYTES in src/services/evidence-export.ts'
    }
  ]);
}

/** FR-036 (N4) — the monitor's stall threshold is a constant, not a setting; the document says so. */
export function stallThresholdNote(): string {
  return `The ${Math.round(MONITOR_STALL_THRESHOLD_MS / 1000)}-second stall threshold is a constant (\`MONITOR_STALL_THRESHOLD_MS\`), not a setting: a Run that has been silent that long is reported as stalled, and no setting changes it.`;
}

const code = (value: string): string => `\`${value}\``;

/** The disclosure as a Markdown table, for the operator document. */
export function renderRetentionDisclosure(): string {
  const rows = retentionDisclosure()
    .map(
      (row) =>
        `| ${row.store} | ${row.location.split(/\s+/).map(code).join(', ')} | ${row.contentClass}, ${
          row.redacted ? 'redacted' : '**not redacted**'
        } | ${row.bounds} | ${row.sweptBy.join(', ')} | ${row.liveProtection} | ${row.onDelete} | ${row.onExport} | ${code(row.source)} |`
    )
    .join('\n');
  return [
    '| Store | Location | Content | Bounds | Swept by | Live protection | On delete | On export | Derived from |',
    '|---|---|---|---|---|---|---|---|---|',
    rows,
    '',
    stallThresholdNote()
  ].join('\n');
}
