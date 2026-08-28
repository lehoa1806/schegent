// FR-R3-136 (FR-013, FR-014, FR-015) — what a workspace is allowed to say about
// Schegent's settings while it is untrusted.
//
// WHAT THE MANIFEST SAID BEFORE THIS FILE: nothing.
// `capabilities.untrustedWorkspaces` declared `supported: "limited"` with a
// paragraph about which commands are refused, and no
// `restrictedConfigurations` key at all. A workspace that ships
// `.vscode/settings.json` therefore spoke with full authority over all
// twenty-eight of its workspace-settable properties in a window the operator had
// explicitly declined to trust. The commands were gated; the settings the
// commands read were not.
//
// WHY A CLASS PER PROPERTY, and not a boolean.
// `restrictedConfigurations` is a flat list, so the manifest cannot say WHY a
// property is on it, and a hand-kept flat list cannot distinguish "nothing else is
// sensitive" from "nobody has looked since". That is `FR-R3-134`'s registry
// failure, and the fix is the same one: state the policy as a small closed set of
// classes, assign every property exactly one class, and DERIVE the list. Fourteen
// entries then follow from four rules a reviewer can hold in their head, instead of
// twenty-eight opinions nobody will re-read.
//
// THE ONE FACT THAT SHAPES EVERY ROW: `restrictedConfigurations` has effect ONLY
// while the workspace is untrusted. In that window Schegent starts no Run — Phase
// B refuses every mutating command and `GuardedRunService` refuses admission on
// its own account, Phase C's producers elect nothing and spawn nothing. So the
// question for each property is not "could a hostile value hurt?" but "could a
// hostile value hurt HERE, in a window where nothing runs?" That is what puts
// fourteen properties in `run-shape` with one shared argument rather than fourteen
// separate ones, and it is also why `run-shape` is the class most likely to need
// revisiting: it is an argument about reachability, and reachability changes.

/**
 * Why a workspace value is or is not allowed to speak while untrusted. Closed set
 * — a fifth class is a fifth policy, and it belongs in a review, not in a diff.
 */
export type SensitivityClass =
  /**
   * The value votes on what Schegent may do. A repository must not get a vote on
   * its own capability, even where a resolution ladder already makes the vote
   * non-decisive: `FR-R3-108` fixed `trust.*` so a workspace `true` cannot defeat
   * a user `false`, and restricting the properties turns that argued guarantee
   * into a structural one.
   */
  | 'capability'
  /**
   * The value can silence, soften, or hide something the operator is shown or
   * asked. A window that refuses everything and cannot say so is worse than one
   * that refuses nothing, because the operator has no way to find out.
   */
  | 'operator-signal'
  /**
   * The value names a path evidence is written to, or a bound on how long
   * evidence is kept. Redirection and truncation are the same attack with
   * different arithmetic.
   */
  | 'evidence'
  /**
   * The value tunes a Run: bounds, retries, models, spend, concurrency, which
   * pipeline, which failure signatures. Left unrestricted, because a Run is
   * exactly what an untrusted window cannot start, so the value has nothing to
   * act on until the operator trusts the folder — at which point a repository
   * tuning its own runs is the intended use and the whole point of `resource`
   * scope. THE HARDEST ROW IN THIS CLASS IS `retry.forceContinueOnCap`, whose own
   * description says "whatever the condition gates is left unverified": a
   * repository can make its own gates advisory. It stays here because it can only
   * do so during a Run the operator started after trusting the folder, and a
   * trusted repository can already ship a phase with `forceContinueOnRetryCap`
   * set per row. Named rather than quietly filed.
   */
  | 'run-shape';

/** The classes whose properties go into `restrictedConfigurations`. */
export const RESTRICTED_CLASSES: ReadonlySet<SensitivityClass> = Object.freeze(
  new Set<SensitivityClass>(['capability', 'operator-signal', 'evidence'])
);

/**
 * Every workspace-settable property in `contributes.configuration`, with its
 * class and the reason in one line. Twenty-eight rows: 4 `window` + 24
 * `resource`. The nine `application`-scoped properties are absent by
 * construction and are held separately by `EXECUTABLE_AUTHORITY_PROPERTIES`
 * below — a workspace cannot set them, so they need no disposition, and the
 * safety of that comes from the SCOPE, which is the thing that can regress.
 */
export const CONFIGURATION_SENSITIVITY = Object.freeze({
  // ---- capability (2) ----
  'schegent.trust.allowCustomPhases': {
    sensitivity: 'capability',
    reason: 'votes on whether non-default phase definitions may be saved'
  },
  'schegent.trust.allowCustomRetryConditions': {
    sensitivity: 'capability',
    reason: 'votes on whether non-default retry-condition expressions may be saved'
  },

  // ---- operator-signal (4) ----
  'schegent.ui.confirmations.enable': {
    sensitivity: 'operator-signal',
    reason: 'false removes the confirmation dialog from ten destructive actions'
  },
  'schegent.multiRoot.suppressWarning': {
    sensitivity: 'operator-signal',
    reason: 'true hides the toast naming which folder .schegent/ state is created in'
  },
  'schegent.logging.runtimeLogLevel': {
    sensitivity: 'operator-signal',
    reason: 'can suppress the log lines that record what an untrusted window refused'
  },
  'schegent.logging.verbose': {
    sensitivity: 'operator-signal',
    reason: 'same surface as runtimeLogLevel, reached through a second key'
  },

  // ---- evidence (8) ----
  'schegent.logging.runtimeLogFilePath': {
    sensitivity: 'evidence',
    reason:
      'names the file the Stage-1 runtime sink appends to, and that sink is attached ' +
      'before any trust decision this feature makes'
  },
  'schegent.logging.runtimeLogMaxBytes': {
    sensitivity: 'evidence',
    reason: 'bounds the runtime log, so a small value truncates the refusal record'
  },
  'schegent.logging.runtimeLogMaxGenerations': {
    sensitivity: 'evidence',
    reason: 'bounds how many rotated runtime logs survive'
  },
  'schegent.logging.rawTranscriptMode': {
    sensitivity: 'evidence',
    reason: 'always retains unredacted prompts, source and model output for every run'
  },
  'schegent.logging.sessionRetentionMaxAgeDays': {
    sensitivity: 'evidence',
    reason: 'bounds how long .schegent/sessions evidence is kept'
  },
  'schegent.logging.sessionRetentionMaxBytes': {
    sensitivity: 'evidence',
    reason: 'same retention sweep, bounded by size instead of age'
  },
  'schegent.audit.rotation.maxAgeDays': {
    sensitivity: 'evidence',
    reason: 'rotates the audit log by age, and the audit log is the tamper-evident record'
  },
  'schegent.audit.rotation.sizeMB': {
    sensitivity: 'evidence',
    reason: 'same rotation, bounded by size instead of age'
  },

  // ---- run-shape (14) ----
  'schegent.claude.autoCompactPctOverride': {
    sensitivity: 'run-shape',
    reason: 'a compaction percentage consulted while a run is in flight'
  },
  'schegent.defaultPipelineId': {
    sensitivity: 'run-shape',
    reason:
      'names a catalog id, and the catalog does not activate untrusted at all ' +
      '(feature 099 isCatalogActivationTrusted)'
  },
  'schegent.fatalSignatures': {
    sensitivity: 'run-shape',
    reason:
      'additive only and cannot remove code-resident signatures; the worst a hostile ' +
      "value does is fail this repository's own runs sooner"
  },
  'schegent.invocation.idleTimeoutSeconds': {
    sensitivity: 'run-shape',
    reason: 'bounds a CLI invocation that an untrusted window never starts'
  },
  'schegent.invocation.maxDurationSeconds': {
    sensitivity: 'run-shape',
    reason: 'bounds a CLI invocation that an untrusted window never starts'
  },
  'schegent.invocation.timeoutSeconds': {
    sensitivity: 'run-shape',
    reason: 'bounds a CLI invocation that an untrusted window never starts'
  },
  'schegent.loop.maxIterations': {
    sensitivity: 'run-shape',
    reason: 'bounds phase iteration inside a run'
  },
  'schegent.models': {
    sensitivity: 'run-shape',
    reason: 'model identifiers passed to a backend an untrusted window never spawns'
  },
  'schegent.queue.globalConcurrencyCap': {
    sensitivity: 'run-shape',
    reason: 'caps concurrent runs, of which an untrusted window has none'
  },
  'schegent.retry.forceContinueOnCap': {
    sensitivity: 'run-shape',
    reason:
      "the class's hardest row — it can leave a phase gate unverified, but only " +
      'during a run the operator started after trusting the folder, and a trusted ' +
      'repository can already set forceContinueOnRetryCap per phase row'
  },
  'schegent.retry.maxAttempts': {
    sensitivity: 'run-shape',
    reason: 'bounds retries inside a run'
  },
  'schegent.spend.maxTokensPerRun': {
    sensitivity: 'run-shape',
    reason: 'a per-run spend ceiling, and an untrusted window spends nothing'
  },
  'schegent.spend.maxUsdPerRun': {
    sensitivity: 'run-shape',
    reason: 'a per-run spend ceiling, and an untrusted window spends nothing'
  },
  'schegent.watchdog.pollIntervalMinutes': {
    sensitivity: 'run-shape',
    reason:
      'the interval of a timer Phase C never arms untrusted — watchdog reattachment ' +
      'is a producer act'
  }
} as const satisfies Readonly<
  Record<string, { readonly sensitivity: SensitivityClass; readonly reason: string }>
>);

export type ClassifiedConfigurationKey = keyof typeof CONFIGURATION_SENSITIVITY;

/**
 * FR-015 — the nine settings that decide WHICH BINARY runs and WHAT ENVIRONMENT it
 * runs in, every one of them `application`-scoped today.
 *
 * They are not in the map above and must never be: `application` scope means a
 * workspace cannot set them at all, which is a stronger guarantee than
 * `restrictedConfigurations` gives, because it holds in a TRUSTED window too. The
 * hazard is that the scope is one word in `package.json` and nothing today
 * notices if it changes. This list is what the parity gate holds it to — and the
 * failure it catches is a property MOVING here, not a property arriving.
 */
export const EXECUTABLE_AUTHORITY_PROPERTIES: readonly string[] = Object.freeze([
  'schegent.agy.path',
  'schegent.backend.probeTimeoutSeconds',
  'schegent.backend.runner',
  'schegent.backend.uncontainedBackends',
  'schegent.cli.environmentAllowlist',
  'schegent.cli.environmentMode',
  'schegent.cli.inheritEnvironment',
  'schegent.cli.path',
  'schegent.codex.path'
]);

/** The scopes a workspace can set. VS Code treats an absent scope as `window`. */
export const WORKSPACE_SETTABLE_SCOPES: ReadonlySet<string> = Object.freeze(
  new Set(['window', 'resource', 'language-overridable'])
);

/**
 * The manifest's `restrictedConfigurations` value, derived. Sorted so the
 * generated list has one form and a diff means a policy change.
 */
export function derivedRestrictedConfigurations(): readonly string[] {
  return Object.entries(CONFIGURATION_SENSITIVITY)
    .filter(([, entry]) => RESTRICTED_CLASSES.has(entry.sensitivity))
    .map(([key]) => key)
    .sort();
}

export interface SensitivityEntry {
  readonly key: string;
  readonly sensitivity: SensitivityClass;
  readonly reason: string;
}

export class UnclassifiedConfigurationError extends Error {
  constructor(public readonly key: string) {
    super(
      `Configuration property ${key} is workspace-settable but has no sensitivity ` +
        `disposition in src/contracts/configuration-trust-dispositions.ts. Add a row ` +
        `naming one of: capability, operator-signal, evidence, run-shape — and say why.`
    );
    this.name = 'UnclassifiedConfigurationError';
  }
}

/**
 * Look a property up, or throw. Exported for the gate rather than for runtime
 * code: nothing at runtime asks this question, because VS Code answers it — the
 * whole point of `restrictedConfigurations` is that the host applies the policy
 * before Schegent ever reads a value.
 */
export function requireSensitivity(key: string): SensitivityEntry {
  const rows: Readonly<
    Record<string, { readonly sensitivity: SensitivityClass; readonly reason: string } | undefined>
  > = CONFIGURATION_SENSITIVITY;
  const entry = rows[key];
  if (entry === undefined) throw new UnclassifiedConfigurationError(key);
  return { key, sensitivity: entry.sensitivity, reason: entry.reason };
}
