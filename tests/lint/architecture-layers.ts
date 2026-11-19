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
 * FR-R7-07 (FR-006) — Declarative per-layer value-import policy enforced by
 * `tests/lint/layer-dependency-direction.test.ts` (complementing the leaf-layer
 * gate in `dependency-direction.test.ts`).
 *
 * Each governed layer maps to the exact set of first-party layers it may
 * value-import. Non-acting layers (`config`, `audit`) remain outside
 * `ACTING_LAYERS` per the FR-R3-128 note above and FR-R7-07's open scope.
 * Additional acting layers join this map in their own successor filings.
 */
export const LAYER_ALLOWED_VALUE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  state: ['state', 'contracts', 'lib', 'config', 'audit']
};

/**
 * A dated, filing-attributed exception to `LAYER_ALLOWED_VALUE_IMPORTS`.
 * Shrink-only: every entry must match a live value import and cite the
 * successor filing that removes it; stale entries fail the gate.
 */
export interface LayerImportAllowlistEntry {
  readonly from: string;
  readonly fromLayer: string;
  readonly intoLayer: string;
  readonly filing: string;
  readonly reason: string;
}

/**
 * FR-R7-07 (SC-001) — Starts empty: all 8 baseline `state/ -> ACTING_LAYERS`
 * value edges (`queue`, `parser`, `services`) were relocated or port-inverted
 * before the gate landed.
 */
export const LAYER_IMPORT_ALLOWLIST: readonly LayerImportAllowlistEntry[] = [];

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
