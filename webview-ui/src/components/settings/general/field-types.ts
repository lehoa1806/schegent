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

import type { BackendRunnerKind, PipelineDefinition } from '../../../lib/snapshot-types';

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
  | 'multiRootSuppressWarning'
  // FR-R3-144 (T025, T031, T036) — the three keys Phase A added to
  // `GeneralSettings` and no surface could reach. `backendRunner` is the one the
  // whole item turns on: the tab assumed Claude, and the setting that decides
  // otherwise had no control.
  | 'backendRunner'
  | 'spendMaxUsdPerRun'
  | 'spendMaxTokensPerRun';

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
  //
  // THE ADD-INTERACTION DECISION (T045). Two list editors ship on the Settings
  // surface and they add items differently: this kind takes a companion input,
  // validates, and refuses; `FatalSignaturesTab.svelte` appends an empty row
  // you type into. Settled here, and the rule keys off the ENTRY rather than
  // the component:
  //
  //   - A CONSTRAINED TOKEN — one with an `itemPattern`, where "invalid" is a
  //     fact the host acts on — uses this kind. Validate at add and keep the
  //     list always-valid; the row is `<code>`, not an input, because a token
  //     is fixed by removing it and adding the right one. Duplicates are
  //     refused on the same ground: the host de-dupes, so a second copy can
  //     only mislead.
  //   - FREE TEXT with no pattern — a prose fragment matched as a substring —
  //     gets an editable row, as the fatal-signatures tab has. There is no
  //     "invalid" to refuse at add, and retyping a 24-character signature to
  //     fix one character is the wrong ask. Duplicates are warned, never
  //     refused: two rows are legitimately equal while one is still being
  //     typed.
  //
  // A new list is a constrained token until shown otherwise, so it lands here.
  // What the rule does not license is the `data-testid` prefixes drifting
  // further apart (`string-list-*` here, `fatal-operator-*` there); that pair
  // is duplication rather than a decision, and stays filed at T045.
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
  // FR-R3-144 (T031) — typed as the backend union rather than `string`, so a
  // selector option the product does not support is a compile error here and not
  // a rejected write the operator discovers after saving.
  backendRunner: BackendRunnerKind;
  // FR-R3-144 (T036) — `null` is the clear sentinel, the same one Feature 012
  // established for `claudeAutoCompactPctOverride`: no bound rather than a bound
  // of zero. `settings-draft.ts` treats all three alike.
  spendMaxUsdPerRun: number | null;
  spendMaxTokensPerRun: number | null;
};

export interface FieldStatus {
  status: 'pending' | 'accepted' | 'rejected';
  reason?: string;
}

export type StatusByKey = Partial<Record<ScalarKey, FieldStatus>>;

// FR-R3-143 (T005) — the contract every group component in this directory
// renders against. The tab owns the draft, the status map and the four
// callbacks; a group owns only its heading and its slice of `FIELDS`.
/**
 * One backend's whole presence on this tab.
 *
 * FR-R3-144 (T025, D-5) — this type exists so `BACKENDS` can be a
 * `Readonly<Record<BackendRunnerKind, BackendSection>>`. The record is the
 * mechanism FR-001 asks for and the reason it is a `Record` rather than the `Map`
 * host code uses for the same association: adding a fourth member to
 * `BackendRunnerKind` makes the record a **compile error** until that backend has
 * a section, where a `Map` or an array would compile and render two backends out
 * of four.
 *
 * It replaces `BACKEND_FIELDS[i]` paired against `RUNNERS[i]` by position. That
 * pairing was correct only because the two arrays happened to be written in the
 * same order, and nothing checked: a path spec inserted at the front would have
 * drawn Claude's path under Codex's Ping button, with every test still green.
 *
 * The type lives here; the record itself must stay in `.svelte`, because its
 * `key:`/`ipcKey:` literals are the evidence base of the settings coverage gate
 * (`tests/integration/settings-surface.integration.test.ts`), which scans
 * `.svelte` files and nothing else. See this file's header.
 */
export interface BackendSection {
  /** Display name, e.g. `Claude`. */
  readonly label: string;
  /** Where this backend's executable is configured. */
  readonly path: FieldSpec;
  /**
   * Settings only this backend honours.
   *
   * Empty is a real, rendered answer (T030): the section says so in a sentence
   * rather than leaving a blank region, because a blank region reads as a surface
   * that failed to load.
   */
  readonly specific: readonly FieldSpec[];
}

export interface SettingsGroupProps {
  fields: readonly FieldSpec[];
  draft: Draft;
  statusByKey: StatusByKey;
  pipelines: readonly PipelineDefinition[];
  fieldChanged: (key: ScalarKey) => boolean;
  fieldScopeLabel: (key: ScalarKey) => string;
  saveOne: (spec: FieldSpec) => void;
  resetField: (key: ScalarKey) => void;
  // FR-R3-144 (T036) — `onAutoCompactInput` is GONE from this contract. It was a
  // handler named after one Claude-only setting, declared on the tab, and passed
  // through every group — including groups with no clearable number in them — to
  // reach the single `kind: 'number-optional'` arm in `GeneralSettingFieldRow`,
  // which wrote `draft.claudeAutoCompactPctOverride` by name. The two per-run
  // spend bounds are the second and third fields of that kind, so the arm writes
  // `draft[spec.key]` like every other arm, and the row owns its own handler. See
  // `onClearableNumberInput` there.
}
