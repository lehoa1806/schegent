// The layer declaration both dependency gates read.
//
// FR-R3-128 (T1486) — it was declared inside `dependency-direction.test.ts`, which
// was fine while one gate used it. `import-graph-acyclic.test.ts` needs the same
// two lists, and two lists of layers is how two gates come to disagree about the
// architecture they both police — the duplicate-authority shape this round has
// removed repeatedly.
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

