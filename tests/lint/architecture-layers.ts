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
 * FR-R7-07 (FR-006), FR-R8-04 (04-03), & principal-review-2026-11-27-r2 (F-06) —
 * Declarative per-layer value-import policy enforced by
 * `tests/lint/layer-dependency-direction.test.ts` (complementing the leaf-layer
 * gate in `dependency-direction.test.ts`).
 *
 * Each governed layer maps to the exact set of first-party layers it may
 * value-import. Non-acting layers (`config`, `audit`) remain outside
 * `ACTING_LAYERS` per the FR-R3-128 note above.
 *
 * Governed layers form a strict acyclic partial order:
 *   controller -> services -> {queue, runner, metrics} -> {parser, state} -> config -> {contracts, lib}
 *
 * `services` joined in FR-R8-04 (`04-03`); `controller`, `runner`, `queue`,
 * `config`, `parser`, and `metrics` joined in `principal-review-2026-11-27-r2 F-06`
 * so every layer currently participating in a layer-level cycle with `services`
 * (or sitting above `services`) has its allowed value-import surface locked down
 * and today's reverse edges frozen under the exact-target shrink-only allowlist.
 */
export const LAYER_ALLOWED_VALUE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  config: ['config', 'contracts', 'lib', 'catalog'],
  parser: ['parser', 'contracts', 'lib', 'audit'],
  state: ['state', 'contracts', 'lib', 'config', 'audit'],
  metrics: ['metrics', 'contracts', 'lib', 'audit', 'parser', 'state'],
  queue: ['queue', 'contracts', 'lib', 'config', 'audit', 'state'],
  runner: ['runner', 'contracts', 'lib', 'config', 'audit', 'parser', 'state'],
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
  ],
  controller: [
    'controller',
    'contracts',
    'lib',
    'config',
    'audit',
    'state',
    'queue',
    'parser',
    'runner',
    'services'
  ]
};

/**
 * principal-review-2026-11-27-r2 (F-06 / D3) — Upper layers that `src/contracts/`
 * should not reverse-import even as TypeScript `import type` edges. Today's
 * reverse type edges are pinned under a shrink-only per-layer ceiling so contract
 * modules cannot grow new upward type coupling.
 */
export const CONTRACTS_REVERSE_TYPE_EDGE_CEILINGS: Readonly<Record<string, number>> = {
  services: 9,
  state: 4,
  controller: 1,
  runner: 2,
  queue: 5
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
  },

  // ---- 28 frozen reverse value edges into `services/` from newly governed layers (principal-review-2026-11-27-r2 F-06)
  // config -> services (2)
  {
    from: 'src/config/pipeline-snapshot.ts',
    fromLayer: 'config',
    intoLayer: 'services',
    target: 'src/services/phase-context/policy.ts',
    owner: 'phase-handoff',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Pipeline snapshot reads pure phase-context policy defaults from services/phase-context/policy.ts; relocate pure policy helpers to contracts/ on next touch.'
  },
  {
    from: 'src/config/workflow-handoff-policy-validator.ts',
    fromLayer: 'config',
    intoLayer: 'services',
    target: 'src/services/phase-context/policy.ts',
    owner: 'phase-handoff',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Workflow handoff validator reads pure phase-context policy helpers from services/phase-context/policy.ts; relocate pure policy helpers to contracts/ on next touch.'
  },

  // parser -> services (1)
  {
    from: 'src/parser/stream-json-unwrapper.ts',
    fromLayer: 'parser',
    intoLayer: 'services',
    target: 'src/services/phase-log/phase-log-jsonl-parser.ts',
    owner: 'phase-log',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Stream JSON unwrapper reuses pure JSONL parsing helper hosted in services/phase-log/phase-log-jsonl-parser.ts; move pure parser down to parser/ or lib/ on next touch.'
  },

  // metrics -> services (2)
  {
    from: 'src/metrics/metrics-rollup-writer.ts',
    fromLayer: 'metrics',
    intoLayer: 'services',
    target: 'src/services/evidence-health/evidence-health-monitor.ts',
    owner: 'operator-evidence',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Metrics rollup writer uses evidence-health helper from services/evidence-health/evidence-health-monitor.ts; invert via a narrow port in contracts/ on next touch.'
  },
  {
    from: 'src/metrics/metrics-service.ts',
    fromLayer: 'metrics',
    intoLayer: 'services',
    target: 'src/services/usage-reader.ts',
    owner: 'operator-evidence',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Metrics service reads usage records through services/usage-reader.ts; inject reader port or relocate pure usage reader below services/ on next touch.'
  },

  // queue -> services (2)
  {
    from: 'src/queue/terminal-capture.ts',
    fromLayer: 'queue',
    intoLayer: 'services',
    target: 'src/services/run-degradation.ts',
    owner: 'queue-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Queue terminal capture calls pure run-degradation classifier in services/run-degradation.ts; relocate pure classifier to contracts/ or state/ on next touch.'
  },
  {
    from: 'src/queue/terminal-capture.ts',
    fromLayer: 'queue',
    intoLayer: 'services',
    target: 'src/services/run-planned-total.ts',
    owner: 'queue-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Queue terminal capture calls pure planned-phase counter in services/run-planned-total.ts; relocate pure counter to contracts/ or state/ on next touch.'
  },

  // runner -> services (21)
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/acp-client.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner drives AcpClient currently housed in services/acp-runtime/; inject via port or relocate acp-runtime transport below runner/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/agent-identifier.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner uses pure agent-identifier helper in services/acp-runtime/agent-identifier.ts; relocate pure helper to contracts/ or lib/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/client-guards.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner calls client guard predicates in services/acp-runtime/client-guards.ts; relocate pure guards to contracts/ or runner/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/acp-durable-runtime-store.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner writes durable ACP runtime records via services/acp-runtime/acp-durable-runtime-store.ts; invert behind a narrow store port on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/profiles.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner reads built-in ACP profile descriptors from services/acp-runtime/profiles.ts; relocate pure profile definitions to contracts/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/stdio-transport.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner constructs stdio transport from services/acp-runtime/stdio-transport.ts; inject transport factory or move transport under runner/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/containment-qualification/acp-authority-gate.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner enforces AcpAuthorityGate from services/containment-qualification/; invert behind a gate port injected from activation/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/phase-context/handoff-delivery-coordinator.ts',
    owner: 'phase-handoff',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner invokes phase-context handoff helper in services/phase-context/; inject delivery port from activation/ on next touch.'
  },
  {
    from: 'src/runner/acp-backed-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/execution-lanes/git-runner.ts',
    owner: 'execution-lanes',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'AcpBackedRunner calls git-runner helper in services/execution-lanes/git-runner.ts; relocate low-level git runner to lib/ or inject port on next touch.'
  },
  {
    from: 'src/runner/acp-runner-stream-helpers.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/terminal-reconciliation.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'ACP stream helpers call pure terminal-reconciliation helper in services/acp-runtime/; relocate pure helper to contracts/ or parser/ on next touch.'
  },
  {
    from: 'src/runner/acp-stream-encoder.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/acp-runtime/agent-identifier.ts',
    owner: 'acp-runtime',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'ACP stream encoder reads agent-identifier helper from services/acp-runtime/agent-identifier.ts; relocate pure helper to contracts/ on next touch.'
  },
  {
    from: 'src/runner/agy-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-enforcement-plan.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Agy CLI runner reads pure capability-enforcement plan helper from services/capability-enforcement-plan.ts; relocate pure helper to contracts/ on next touch.'
  },
  {
    from: 'src/runner/agy-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-refusal.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Agy CLI runner constructs CapabilityRefusalError from services/capability-refusal.ts; relocate error contract to contracts/ on next touch.'
  },
  {
    from: 'src/runner/backend-runner-factory.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/backend-containment-policy.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'BackendRunnerFactory checks pure containment policy helpers in services/backend-containment-policy.ts; relocate pure policy helpers to contracts/ on next touch.'
  },
  {
    from: 'src/runner/backend-runner-registry.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/backend-containment-policy.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'BackendRunnerRegistry checks pure containment policy helpers in services/backend-containment-policy.ts; relocate pure policy helpers to contracts/ on next touch.'
  },
  {
    from: 'src/runner/claude-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-enforcement-plan.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Claude CLI runner reads pure capability-enforcement plan helper from services/capability-enforcement-plan.ts; relocate pure helper to contracts/ on next touch.'
  },
  {
    from: 'src/runner/claude-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-refusal.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Claude CLI runner constructs CapabilityRefusalError from services/capability-refusal.ts; relocate error contract to contracts/ on next touch.'
  },
  {
    from: 'src/runner/codex-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-enforcement-plan.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Codex CLI runner reads pure capability-enforcement plan helper from services/capability-enforcement-plan.ts; relocate pure helper to contracts/ on next touch.'
  },
  {
    from: 'src/runner/codex-cli.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-refusal.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Codex CLI runner constructs CapabilityRefusalError from services/capability-refusal.ts; relocate error contract to contracts/ on next touch.'
  },
  {
    from: 'src/runner/native-review-launch.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/capability-refusal.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'Native review launcher constructs CapabilityRefusalError from services/capability-refusal.ts; relocate error contract to contracts/ on next touch.'
  },
  {
    from: 'src/runner/spawn-gated-runner.ts',
    fromLayer: 'runner',
    intoLayer: 'services',
    target: 'src/services/containment-qualification/admission-refusal.ts',
    owner: 'containment-policy',
    filing: 'principal-review-2026-11-27-r2 F-06',
    reason: 'SpawnGatedRunner constructs ContainmentAdmissionRefusedError from services/containment-qualification/admission-refusal.ts; relocate error contract to contracts/ on next touch.'
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
