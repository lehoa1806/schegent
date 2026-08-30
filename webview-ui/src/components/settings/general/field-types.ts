// FR-R3-143 (T001) — the single definition of the three types the general
// settings surface is built from. They were declared twice, byte-identically,
// in `GeneralSettingsTab.svelte` and `GeneralSettingFieldRow.svelte`; a member
// added to one union and not the other compiled, and the row silently rendered
// the `{:else}` text-input arm. One declaration, imported by both.
//
// `Draft` was originally left out on the grounds that the two declarations
// "are not verbatim duplicates" — 24 lines against 19. That is true of the
// text and false of the type: the difference is three comments, and the two
// declare the same seventeen fields with the same types. It is extracted here
// with the comments kept, because T005-T008 add four more components that need
// it and re-declaring it in each would turn two copies into six.
//
// What deliberately does NOT live here:
//   - `StringKey` — declared only in the row component, where it narrows the
//     four path-valued keys for that component's own bindings.
//   - the `FIELDS` arrays — their `key:` literals must stay in `.svelte`,
//     which is all the settings coverage gate scans
//     (`tests/integration/settings-surface.integration.test.ts:252`).

import type { PipelineDefinition } from '../../../lib/snapshot-types';

export type ScalarKey =
  | 'cliPath'
  | 'codexPath'
  | 'agyPath'
  | 'loggingVerbose'
  | 'loopMaxIterations'
  | 'invocationIdleTimeoutSeconds'
  | 'invocationMaxDurationSeconds'
  | 'watchdogPollIntervalMinutes'
  | 'auditRotationSizeMB'
  | 'auditRotationMaxAgeDays'
  | 'defaultPipelineId'
  | 'claudeAutoCompactPctOverride'
  | 'runtimeLogLevel'
  | 'runtimeLogFilePath'
  | 'sessionRetentionMaxAgeDays'
  | 'sessionRetentionMaxBytes'
  | 'rawTranscriptMode'
  // FR-R3-143 (T012, T013) — four keys the host has accepted all along
  // and the tab never drew.
  | 'retryMaxAttempts'
  | 'retryForceContinueOnCap'
  | 'runtimeLogMaxBytes'
  | 'runtimeLogMaxGenerations'
  // FR-R3-143 (T031, T032) — six the manifest declares that no surface in the
  // product could reach. Four are `application`-scoped and write to Global;
  // two are `window`-scoped and write to Workspace.
  | 'cliInheritEnvironment'
  | 'cliEnvironmentMode'
  | 'cliEnvironmentAllowlist'
  | 'backendProbeTimeoutSeconds'
  | 'uiConfirmationsEnable'
  | 'multiRootSuppressWarning';

export type FieldKind =
  | 'string'
  | 'boolean'
  | 'number'
  | 'pipeline-select'
  | 'number-optional'
  | 'level-select'
  | 'raw-transcript-select'
  // FR-R3-143 (T029) — the generic enum, driven by `FieldSpec.options`, so the
  // next enum setting does not become a fourth bespoke `*-select` kind.
  // `level-select` and `raw-transcript-select` are deliberately NOT folded into
  // it: their option LABELS differ from their values ("Errors only" for
  // `errors-only`), and rewriting them is a change to shipped surfaces this
  // feature was not asked to make.
  | 'enum'
  // FR-R3-143 (T030) — an editable list of strings.
  | 'string-list';

export interface FieldSpec {
  readonly key: ScalarKey;
  // Wire-format IPC key (defaults to `key`). Feature 012 uses dotted
  // names like `claude.autoCompactPctOverride` for the new override.
  readonly ipcKey?: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
  /** Accepted values for `kind: 'enum'`. Rendered verbatim as both value and label. */
  readonly options?: readonly string[];
  /**
   * FR-R3-143 (T030) — element pattern for `kind: 'string-list'`. Supplied by
   * the tab from `SETTINGS_SCHEMA`, the same record the host's write path reads
   * it from, so the editor cannot accept a value the host would refuse.
   */
  readonly itemPattern?: string;
  /**
   * What the operator is told when an entry fails `itemPattern`. It sits beside
   * the pattern because it is the human-readable half of the same rule: a
   * regex in a validation message is precise and unreadable, and the semantics
   * ("a legal environment variable name") live where the field is declared.
   */
  readonly invalidMessage?: string;
  /**
   * A sentence rendered under the control, before the operator saves.
   *
   * FR-R3-143 (T031, T032) — this exists because four of the six settings this
   * feature surfaces reach beyond the workspace or beyond this session, and a
   * control that does not say so is worse than no control: it invites a change
   * whose blast radius or latency the operator cannot see. Not decoration.
   */
  readonly note?: string;
}

export type Draft = {
  cliPath: string;
  codexPath: string;
  agyPath: string;
  loggingVerbose: boolean;
  loopMaxIterations: number;
  invocationIdleTimeoutSeconds: number;
  invocationMaxDurationSeconds: number;
  watchdogPollIntervalMinutes: number;
  auditRotationSizeMB: number;
  auditRotationMaxAgeDays: number;
  defaultPipelineId: string;
  // Feature 012: `null` is the "clear / use CLI default" sentinel; the
  // host translates a payload of `null` to `config.update(key, undefined)`.
  claudeAutoCompactPctOverride: number | null;
  // Feature 019: runtime debug log sink controls.
  runtimeLogLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  runtimeLogFilePath: string;
  sessionRetentionMaxAgeDays: number;
  sessionRetentionMaxBytes: number;
  rawTranscriptMode: 'always' | 'errors-only' | 'off';
  retryMaxAttempts: number;
  retryForceContinueOnCap: boolean;
  runtimeLogMaxBytes: number;
  runtimeLogMaxGenerations: number;
  cliInheritEnvironment: boolean;
  cliEnvironmentMode: string;
  // Mutable, and a COPY of the projection's frozen array: the list editor
  // splices this in place, and splicing the projected value would mutate the
  // snapshot the "changed" comparison is made against.
  cliEnvironmentAllowlist: string[];
  backendProbeTimeoutSeconds: number;
  uiConfirmationsEnable: boolean;
  multiRootSuppressWarning: boolean;
};

export interface FieldStatus {
  status: 'pending' | 'accepted' | 'rejected';
  reason?: string;
}

export type StatusByKey = Partial<Record<ScalarKey, FieldStatus>>;

// FR-R3-143 (T005) — the contract every group component in this directory
// renders against. The tab owns the draft, the status map and the four
// callbacks; a group owns only its heading and its slice of `FIELDS`.
export interface SettingsGroupProps {
  fields: readonly FieldSpec[];
  draft: Draft;
  statusByKey: StatusByKey;
  pipelines: readonly PipelineDefinition[];
  fieldChanged: (key: ScalarKey) => boolean;
  fieldScopeLabel: (key: ScalarKey) => string;
  saveOne: (spec: FieldSpec) => void;
  resetField: (key: ScalarKey) => void;
  onAutoCompactInput: (ev: Event) => void;
}
