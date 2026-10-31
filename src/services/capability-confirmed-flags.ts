// FR-R4-F06 (FR-029, FR-033; contract Q, Q3; K3) -- the capability flags an installed CLI was SHOWN to list.
//
// WHAT THIS IS. A transcription of one run of `scripts/capture-backend-help.mjs claude codex agy`,
// taken on the cycle host (darwin) on 2026-10-31 under the minimal policy's shape and an isolated,
// empty home, with no account and no model call. The versions it was taken at:
//
//   claude 2.1.316    codex-cli 0.163.0    agy 1.4.12
//
// and the output itself is recorded in specs/253-backend-authority-teardown/measurements.md, section 3.
// A flag is here because that CLI's `--help` listed it, and for no other reason.
//
// WHAT IT GATES. The capability planner refuses a withheld capability whose flag is not in this list,
// and says the flag is UNQUALIFIED: it exists in the planner's table, and no capture has confirmed the
// installed CLI lists it. A cell is never enforced on the strength of a flag nobody has seen.
//
// WHAT IT DOES NOT CLAIM. Only the flag NAME's presence in `--help`. It does not say a flag's values
// are accepted, that the flag enforces anything, or that it still does at another version; the
// qualification record states that limit (docs/architecture/backend-containment-qualification.md,
// section 7), and `QUALIFIED_BACKEND_VERSIONS` is gated against the release log, not against this list.
//
// KEEPING IT TRUE. Re-run the capture and transcribe it here in the same commit as the record's
// sections 7 and 8, or not at all. `tests/lint/containment-qualification-parity.test.ts` fails a
// record whose observed rows and this list disagree.
import type { BackendRunnerKind } from '../contracts/backend-kinds';

export const CONFIRMED_FLAGS: Readonly<Record<BackendRunnerKind, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode']),
  codex: Object.freeze(['--sandbox']),
  agy: Object.freeze(['--dangerously-skip-permissions', '--sandbox'])
});
