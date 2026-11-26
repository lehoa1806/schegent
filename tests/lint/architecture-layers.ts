// The layer declaration all dependency gates read.
//
// FR-R3-128 (T1486) — it was declared inside `dependency-direction.test.ts`, which
// was fine while one gate used it. `import-graph-acyclic.test.ts` and
// `layer-dependency-direction.test.ts` need the same declarations, and two lists
// of layers is how two gates come to disagree about the architecture they both
// police — the duplicate-authority shape this round has removed repeatedly.
//
// Lives outside any `.test.ts` so importing it does not re-register another file's
// suite, which is the same reason `envelope-presence.ts` sits here.

/** Layers that may not value-import a layer that acts. */
export const LEAF_LAYERS: ReadonlyArray<{ readonly dir: string; readonly role: string }> = [
  { dir: 'contracts', role: 'describes the shapes both sides agree on; it may not depend on either' },
  { dir: 'lib', role: 'small helpers with no domain knowledge' }
];

/** The layers that ACT. A leaf reaching one of these is the inversion. */
export const ACTING_LAYERS = [
  'activation',
  'catalog',
  'commands',
  'controller',
  'headless',
  'host-services',
  'metrics',
  'monitor',
  'parser',
  'queue',
  'runner',
  'services',
  'state',
  'telemetry',
  'ui',
  'watchdog'
] as const;

// FR-R3-128 — COPIED VERBATIM, and the first attempt was not.
//
// Extracting this list, I added `audit` and `config` to it. Both look like layers
// that act, and adding them is a defensible change — but it is a CHANGE, and it
// widened the rule inside a refactor whose whole premise is that nothing observable
// moves. It immediately reported `src/contracts/privacy-profiles.ts` (FR-R3-127,
// merged hours earlier) as an inversion for reading `SETTINGS_SCHEMA` from
// `src/config/`.
//
// The list is restored exactly. Whether `config` and `audit` belong here is a real
// question with a real consequence — under `config` as acting, a contract may not
// read a settings default, and `privacy-profiles.ts` deliberately does, so that
// module would have to move or the rule would need an exception. That is a decision
// about the architecture, not a line in a refactor, and it is recorded here for
// whoever takes it rather than taken in passing.

/**
 * FR-R7-07 (FR-006) & FR-R8-04 (04-03) — Declarative per-layer value-import policy
 * enforced by `tests/lint/layer-dependency-direction.test.ts` (complementing the
 * leaf-layer gate in `dependency-direction.test.ts`).
 *
 * Each governed layer maps to the exact set of first-party layers it may
 * value-import. Non-acting layers (`config`, `audit`) remain outside
 * `ACTING_LAYERS` per the FR-R3-128 note above.
 *
 * `services` joins this map in FR-R8-04 (`04-03`) to prevent any new reverse
 * runtime value edge into `controller/`, `commands/`, `ui/`, `activation/`,
 * `headless/`, or top-level `root`, while holding all 11 reconciled
 * `services/ -> controller/` edges under an exact-target, owner-attributed
 * shrink-only allowlist below (0 `services/ -> commands|ui` edges remain).
 */
export const LAYER_ALLOWED_VALUE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  state: ['state', 'contracts', 'lib', 'config', 'audit'],
  services: [
    'services',
    'contracts',
    'lib',
    'config',
    'audit',
    'state',
    'queue',
    'catalog',
    'parser',
    'runner',
    'monitor',
    'metrics',
    'telemetry',
    'watchdog',
    'host-services'
  ]
};

/**
 * A dated, owner- and filing-attributed exception to `LAYER_ALLOWED_VALUE_IMPORTS`.
 * Shrink-only: every entry must match a live value import (exact target when
 * `target` is declared) and cite the filing and owner responsible for retiring
 * or keeping it; stale entries fail the gate.
 */
export interface LayerImportAllowlistEntry {
  readonly from: string;
  readonly fromLayer: string;
  readonly intoLayer: string;
  readonly target?: string;
  readonly owner: string;
  readonly filing: string;
  readonly reason: string;
}

/**
 * FR-R7-07 (`state/`: 0 entries) & FR-R8-04 `04-03` (`services/`: exact-target
 * shrink-only registry of the 11 audited `services/ -> controller/` runtime
 * edges; both prior `services/ -> commands|ui` edges have been retired). Any
 * new reverse value import from `services/` fails `layer-dependency-direction.test.ts`.
 */
export const LAYER_IMPORT_ALLOWLIST: readonly LayerImportAllowlistEntry[] = [
  // ---- 11 reconciled `services/ -> controller/` runtime edges (high-coupling-ownership-and-facades.md §2.1)
  {
    from: 'src/services/run-driver.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/phase-runner.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'RunDriver value-imports composePhaseMessagePath (re-exported from controller/phase-sidecar-reader.ts); relocate sidecar path helper to services/ or lib/ on next touch.'
  },
  {
    from: 'src/services/run-driver.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/phase-sequencer.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'RunDriver advances phase order through PhaseSequencer in controller/; relocate pure sequencer logic or pass port on next touch.'
  },
  {
    from: 'src/services/run-driver.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/incomplete-turn-resume.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'RunDriver uses incomplete-turn resume helper owned by controller/; move pure classification helper into contracts/ or lib/ on next touch.'
  },
  {
    from: 'src/services/retry-coordinator.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/retry-handler.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'RetryCoordinator delegates retry timing computation to controller/retry-handler.ts; move pure backoff decision down to lib/ on next touch.'
  },
  {
    from: 'src/services/resume-admission-guard.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/run-admission.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'ResumeAdmissionGuard shares pure run-admission predicate currently hosted in controller/run-admission.ts; relocate to contracts/ on next touch.'
  },
  {
    from: 'src/services/backend-availability-service.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/rate-limit-backoff.ts',
    owner: 'quota-and-availability',
    filing: 'FR-R8-04',
    reason: 'BackendAvailabilityService reuses pure rate-limit backoff helper in controller/rate-limit-backoff.ts; relocate pure math to lib/ on next touch.'
  },
  {
    from: 'src/services/effective-limits.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/effective-phase-timeout.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'Effective limits helper reads pure timeout resolver in controller/effective-phase-timeout.ts; relocate pure resolver to config/ or contracts/ on next touch.'
  },
  {
    from: 'src/services/failure-record/failed-phase-notice.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/phase-control-decision.ts',
    owner: 'operator-evidence',
    filing: 'FR-R8-04',
    reason: 'Failed-phase notice reads pure isRestartExposed predicate in controller/phase-control-decision.ts to ensure one eligibility oracle; relocate pure classifier to contracts/ on next touch.'
  },
  {
    from: 'src/services/phase-context/attempt-result-publisher.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/phase-sidecar-reader.ts',
    owner: 'phase-handoff',
    filing: 'FR-R8-04',
    reason: 'AttemptResultPublisher reads phase sidecar files via controller/phase-sidecar-reader.ts; extract shared pure reader into services/phase-log/ or lib/ on next touch.'
  },
  {
    from: 'src/services/run-planned-total.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/phase.ts',
    owner: 'workflow-runtime',
    filing: 'FR-R8-04',
    reason: 'Planned phase count helper reads pure isLoopPhase predicate in controller/phase.ts; move pure phase predicate to contracts/ on next touch.'
  },
  {
    from: 'src/services/runtime-resource-budgets/resource-inventory.ts',
    fromLayer: 'services',
    intoLayer: 'controller',
    target: 'src/controller/backend-posture-recorder.ts',
    owner: 'resource-budgets',
    filing: 'FR-R8-04',
    reason: 'Resource inventory reads posture cache bound constant from controller/backend-posture-recorder.ts; relocate constant to contracts/ on next touch.'
  }
];

/**
 * FR-R7-07 (SC-005) — Acting layers that no `src/state/` module may reach
 * transitively through static value imports.
 */
export const STATE_FORBIDDEN_TRANSITIVE_LAYERS = [
  'queue',
  'parser',
  'services',
  'controller',
  'ui'
] as const;

/**
 * FR-R7-07 (SC-002) — Per-file size bound for `src/state/` chosen from the
 * cohesive key-family split sizes (`connected-workflow-run.ts` 1,037 lines;
 * split `workspace-state-*.ts` modules ≤ ~850 lines).
 */
export const STATE_MAX_FILE_LINES = 1_100;
