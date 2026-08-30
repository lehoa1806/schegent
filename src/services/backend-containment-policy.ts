import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../contracts/backend-kinds';

/**
 * FR-R3-056 (H-01) — whether a backend may run at all.
 *
 * The decision this enforces is recorded in
 * `docs/architecture/agent-capability-posture.md`: shape 3 of the three the
 * 2026-08-23 review offered. Uncontained backends become a separately enabled
 * mode, and the shipped default refuses them.
 *
 * WHY A REFUSAL AND NOT A WARNING
 *
 * FR-R3-031/032 added disclosure. The review is explicit that disclosure changed
 * informed consent, not reachability or impact, and does not reduce the severity —
 * a document does not bound a process. The only thing that changes reachability is
 * refusing to spawn.
 *
 * WHAT "CONTAINED" MEANS HERE
 *
 * Exactly one thing: the adapter's own argv carries an OS-enforced bound. It is
 * not a claim that the agent is safe, that the sandbox is escape-proof, or that a
 * contained backend cannot damage the workspace — `workspace-write` permits
 * writing the workspace, which is the point of it. It means the operating system,
 * not a prompt, decides what the process can reach.
 *
 * `backend-containment-policy.test.ts` proves this classification against each
 * adapter's actual argv rather than trusting the table below, because a
 * hand-kept restatement of a fact the code already carries is the defect
 * FR-R3-051 spent a whole cycle removing.
 */

/**
 * FR-R3-125 (FR-002) — WHICH boundary, not only whether there is one.
 *
 * `BackendContainment` answers "is there an OS-enforced bound". It cannot answer
 * "which one", so nothing could check
 * `docs/architecture/backend-containment-qualification.md`'s matrix against the
 * product, and a record that cannot be checked is a record that drifts. This
 * table is the one place the answer lives:
 *
 *   - `containmentOf` DERIVES its verdict from it, so the classification and the
 *     mechanism cannot disagree;
 *   - `BackendPostureAdmittedPayload.containmentMechanism` records it per run,
 *     derived at emission and never passed in;
 *   - `tests/lint/containment-qualification-parity.test.ts` asserts the
 *     qualification record names the same mechanism for every backend, failing in
 *     BOTH directions.
 *
 * `none` is a value, never an absent one: a payload with no mechanism field is
 * what a pre-FR-R3-125 log looks like, and "uncontained" must be distinguishable
 * from "not recorded".
 */
export type BackendContainmentMechanism =
  /** `codex exec --sandbox workspace-write`; macOS Seatbelt on darwin. */
  | 'codex-sandbox-workspace-write'
  /** No OS-enforced bound in the adapter's argv. */
  | 'none';

/**
 * Every backend's enforcing mechanism, and the reason for each.
 *
 * VERIFIED 2026-08-27 by invoking each installed CLI's own `--help`; versions and
 * evidence are in the qualification record. Do not edit a row here without editing
 * that record's matrix — the parity gate fails, which is the point.
 *
 * AGY IS `none` AND IT EXPOSES `--sandbox`. This is FR-R3-125's finding and it
 * contradicts the item that filed it: `agy 1.1.22` carries
 * `--sandbox` — "Run in a sandbox with terminal restrictions enabled" — and
 * Schegent does not request it. It is classified `none` anyway, deliberately:
 * this project's definition of contained is that the OPERATING SYSTEM, not a
 * prompt, decides what the process can reach, and "terminal restrictions" is
 * consistent with a tool-level gate — which is what `claude --disallowedTools`
 * already is and which this project has never counted. Qualifying it needs a live
 * invocation this cycle did not make. §4 of the qualification record names the
 * probe and the entry condition for requesting the flag; read it before changing
 * this row.
 */
const MECHANISM_BY_BACKEND: ReadonlyMap<BackendRunnerKind, BackendContainmentMechanism> = new Map<
  BackendRunnerKind,
  BackendContainmentMechanism
>([
  // `--dangerously-skip-permissions`: approval prompts off, no filesystem bound.
  ['claude', 'none'],
  // As above; `--sandbox` exists and is not requested. See the docblock.
  ['agy', 'none'],
  ['codex', 'codex-sandbox-workspace-write']
]);

export type BackendContainment = 'os-enforced' | 'none';

/** The mechanism this backend's argv actually carries. */
export function mechanismOf(kind: BackendRunnerKind): BackendContainmentMechanism {
  return MECHANISM_BY_BACKEND.get(kind) ?? 'none';
}

/**
 * Every backend's mechanism. Exported so the parity gate enumerates rather than
 * samples, for the reason `containmentByBackend` already gives.
 */
export function mechanismByBackend(): ReadonlyMap<BackendRunnerKind, BackendContainmentMechanism> {
  return new Map(
    SUPPORTED_BACKENDS.map((kind: BackendRunnerKind) => [kind, mechanismOf(kind)])
  );
}

/**
 * Derived, not restated. A second set listing the uncontained backends is a second
 * authority for one fact, which is how the two come to disagree.
 */
export function containmentOf(kind: BackendRunnerKind): BackendContainment {
  return mechanismOf(kind) === 'none' ? 'none' : 'os-enforced';
}

/** Every backend, classified. Exported so a gate can enumerate rather than sample. */
export function containmentByBackend(): ReadonlyMap<BackendRunnerKind, BackendContainment> {
  return new Map(SUPPORTED_BACKENDS.map((kind: BackendRunnerKind) => [kind, containmentOf(kind)]));
}

export type ContainmentVerdict =
  | { readonly outcome: 'allowed'; readonly containment: BackendContainment }
  | {
      readonly outcome: 'refused';
      readonly reason: 'uncontained-backend-not-enabled';
      readonly kind: BackendRunnerKind;
      readonly message: string;
    };

/** The setting an operator sets to accept the uncontained posture, per backend. */
export const ALLOW_UNCONTAINED_SETTING = 'schegent.backend.uncontainedBackends';

/** The key this replaced. Named so the refusal message can say what changed. */
export const REMOVED_ALLOW_UNCONTAINED_SETTING = 'schegent.backend.allowUncontainedBackends';

/**
 * FR-R3-125 (FR-004a) — what a list entry can be wrong about, and the two are
 * different problems needing different sentences.
 *
 * `unsupported` is a typo (`"claud"`): the id is not a backend, so the message
 * names the ids that are. `already-contained` is a no-op (`"codex"`): the id IS a
 * backend, it was never refused, so granting it means nothing — and telling that
 * operator "unsupported id" would send them looking for a spelling mistake they
 * did not make.
 *
 * Neither THROWS. A malformed safety setting must fail closed and leave the
 * product usable: an exception here would take down activation, and an operator
 * whose extension will not start does not read the reason.
 */
export type UncontainedEntryProblem =
  | { readonly entry: string; readonly problem: 'unsupported'; readonly message: string }
  | { readonly entry: string; readonly problem: 'already-contained'; readonly message: string };

export interface GrantedUncontainedBackends {
  /** Entries that name a real, currently-uncontained backend. */
  readonly granted: ReadonlySet<BackendRunnerKind>;
  /** Entries that grant nothing, each with why. Empty in the ordinary case. */
  readonly problems: readonly UncontainedEntryProblem[];
}

/**
 * Read the setting's raw value into a grant.
 *
 * Validated rather than filtered (FR-004a): a setting that silently drops what it
 * does not understand cannot be reasoned about by the operator who wrote it.
 * Anything that is not an array of strings yields an empty grant — the
 * fail-closed direction — and every rejected entry is reported.
 */
/**
 * How much of a rejected entry is echoed back, and how many are reported.
 *
 * Both are bounds on operator-controlled input reaching a log line. The value
 * comes from settings, so it is as long as someone made it, and an unbounded echo
 * turns a malformed setting into an unbounded log write — the same reasoning
 * `MAX_REPORTED_PATHS` applies in `run-checkpoint-service.ts`. Truncation is
 * marked, so a reader can tell a long value from a short one.
 */
const MAX_ECHOED_ENTRY_CHARS = 64;
const MAX_REPORTED_ENTRIES = 10;

const echo = (value: string): string =>
  value.length <= MAX_ECHOED_ENTRY_CHARS
    ? value
    : `${value.slice(0, MAX_ECHOED_ENTRY_CHARS)}… (${value.length} chars)`;

export function resolveUncontainedGrant(raw: unknown): GrantedUncontainedBackends {
  const granted = new Set<BackendRunnerKind>();
  const problems: UncontainedEntryProblem[] = [];
  if (!Array.isArray(raw)) return { granted, problems };
  for (const value of raw) {
    // Reporting stops; VALIDATION does not. A list longer than the report bound
    // still grants exactly the entries that are valid, so truncating the report
    // can never widen the grant.
    const report = problems.length < MAX_REPORTED_ENTRIES;
    if (typeof value !== 'string') {
      if (report) {
        problems.push({
          entry: echo(typeof value === 'symbol' ? value.toString() : String(value)),
          problem: 'unsupported',
          message:
            `'${ALLOW_UNCONTAINED_SETTING}' entries must be backend ids; supported ids are ` +
            `${SUPPORTED_BACKENDS.join(', ')}. This entry grants nothing.`
        });
      }
      continue;
    }
    const kind = SUPPORTED_BACKENDS.find((supported: BackendRunnerKind) => supported === value);
    if (kind === undefined) {
      if (report) {
        problems.push({
          entry: echo(value),
          problem: 'unsupported',
          message:
            `'${echo(value)}' is not a backend id. Supported ids are ` +
            `${SUPPORTED_BACKENDS.join(', ')}. This entry grants nothing.`
        });
      }
      continue;
    }
    if (containmentOf(kind) === 'os-enforced') {
      if (!report) continue;
      problems.push({
        entry: value,
        problem: 'already-contained',
        message:
          `'${value}' already carries an OS-enforced bound (${mechanismOf(kind)}) and was never ` +
          `refused, so naming it in '${ALLOW_UNCONTAINED_SETTING}' grants nothing. Remove it.`
      });
      continue;
    }
    granted.add(kind);
  }
  return { granted, problems };
}

/**
 * May this backend run?
 *
 * A pure function of the backend and the granted set, so the decision is testable
 * without a workspace, a CLI, or a spawn — and so both the admission check and
 * the spawn-time check read the same answer instead of each implementing it.
 *
 * FR-R3-125 — the second parameter was a boolean meaning "all uncontained
 * backends are allowed". It is now the set actually granted, so allowing `agy`
 * does not allow `claude`. The parameter stays REQUIRED for the reason
 * `createBackendRunner`'s docblock gives.
 */
export function judgeBackendContainment(
  kind: BackendRunnerKind,
  granted: ReadonlySet<BackendRunnerKind>
): ContainmentVerdict {
  const containment = containmentOf(kind);
  if (containment === 'os-enforced' || granted.has(kind)) {
    return { outcome: 'allowed', containment };
  }
  return {
    outcome: 'refused',
    reason: 'uncontained-backend-not-enabled',
    kind,
    // Names the setting, the exact value to add, the scope of the grant, and the
    // key this replaced. A refusal an operator cannot act on is a refusal they
    // will work around.
    message:
      `The '${kind}' backend runs without an OS-enforced bound on what it can reach: ` +
      'model-generated actions execute with your local user authority. Add ' +
      `'${kind}' to '${ALLOW_UNCONTAINED_SETTING}' to accept that for this backend only, ` +
      'or choose a backend that carries a sandbox. The setting is application-scoped, so it ' +
      `applies to every workspace in this installation. It replaces the removed boolean ` +
      `'${REMOVED_ALLOW_UNCONTAINED_SETTING}', which now grants nothing. See ` +
      'docs/architecture/agent-capability-posture.md and ' +
      'docs/operations/untrusted-repositories.md.'
  };
}

/**
 * FR-R3-056 — thrown rather than returned, because there is no runner to return.
 * A distinct type so a caller can report the posture refusal as itself instead of
 * as a generic construction failure.
 *
 * FR-R3-146 (FR-005) — MOVED HERE from `runner/backend-runner-factory.ts`, where it
 * was declared beside the throw. The controller must now recognise it, and
 * `tests/lint/backend-kind-placement.test.ts` forbids any module outside
 * `src/runner/` taking a VALUE from the factory — the exemption is one file wide and
 * is for the composition root. Adding the controller to that allowlist would widen
 * an exemption whose narrowness is the point.
 *
 * `services/` is where this product already puts a thrown refusal a caller must
 * recognise across a module boundary: `CapabilityNotEnforceableError` in
 * `services/capability-refusal.ts` says so, and cites this type's reasoning while
 * doing it. Here rather than in a file of its own because the message a caller
 * reports is built ten lines above, by `judgeBackendContainment`, and a refusal type
 * separated from the judgement that raises it is two files to keep in step.
 */
export class UncontainedBackendRefusedError extends Error {
  public constructor(
    public readonly kind: BackendRunnerKind,
    message: string
  ) {
    super(message);
    this.name = 'UncontainedBackendRefusedError';
  }
}

/**
 * Recognise the refusal across a module boundary without an instanceof trap.
 *
 * The shape `isCapabilityRefusal` established. A predicate rather than a bare
 * `instanceof` at the call site because the caller is `catch (err: unknown)`, and a
 * predicate narrows without the caller importing the constructor for a type guard
 * it then has to spell itself.
 */
export function isUncontainedBackendRefusal(
  error: unknown
): error is UncontainedBackendRefusedError {
  return error instanceof UncontainedBackendRefusedError;
}
