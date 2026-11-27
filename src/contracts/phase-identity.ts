// FR-R3-110 (FR-104) — a phase's *name* is a contract, so it lives here.
//
// WHY IT MOVED
//
// `PhaseName` was declared in `src/ui/sidebar/snapshot.ts` and imported by
// `src/monitor/` (three modules) and `src/services/run-driver.ts`. The monitor and
// the driver do not render anything; they were importing from a UI projection
// module because that is where the name happened to be declared. Under the
// documented layering that is backwards, and the dependency-direction gate refuses
// it.
//
// The type is deliberately `string` and not a union. Feature 098 removed the
// built-in phase catalog: a phase's name is whatever an operator authored, so a
// closed union here would be a host claim about someone else's catalog — which is
// the defect that union was removed for. Its bound is enforced where authored
// input is validated (`PHASE_NAME_MAX_LEN`), not by its type.
//
// This module imports nothing, on purpose. It is a leaf.

/**
 * The name of a phase, as authored.
 *
 * `string` because the catalog is operator-authored at runtime; see the note above
 * for why this is not a union and must not become one.
 */
export type PhaseName = string;
