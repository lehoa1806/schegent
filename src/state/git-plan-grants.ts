// FR-R3-146 (FR-006, FR-011) — durable "always approve this plan here" grants.
//
// WHY THIS IS A MODULE AND NOT A FIELD ON THE RUN
//
// The consent unit was always the mutation plan: `buildMutationPlan` hashes the
// pipeline id and each phase's id, runner, side effects and prompt version, and
// nothing about the feature or the task. The STORAGE unit was the Run. So a drain
// of twenty tasks over one pipeline produced twenty identical fingerprints and
// twenty byte-identical modals, and the ask-once check at
// `workflow-controller.ts:765-778` could not help: it was never wrong, it simply
// could not see across Runs. This record is that same consent, stored where the
// plan lives rather than where the Run does.
//
// THE READER IS TOTAL
//
// Every input has a defined result and none of them throws — the discipline
// `resolveUncontainedGrant` follows, for the reason
// `backend-execution-wiring.ts:260-263` gives: a malformed safety record must
// leave the product usable, because an operator whose extension will not start
// does not read the reason. A dropped grant costs one modal. A thrown read costs
// activation.
//
// It also fails closed in the only direction that matters. Every rejection path
// drops the entry, so no malformed value can be read as consent — the worst a
// corrupt record can do is ask the operator again.
//
// Extracted from `workspace-state.ts` for the same reason `confirm-suppression.ts`
// was: the memento I/O stays on `WorkspaceStateStore`, the narrowing is testable
// without one.

/**
 * One durable grant. `fingerprint` is stored inside the entry as well as being
 * its map key so a record read on its own — in an audit, in a bug report, in the
 * list `Schegent: Git Approvals` renders — is self-describing. `pipelineId` and
 * `phaseIds` are there for FR-012: an operator must be able to tell what they
 * granted without reading source.
 *
 * WHERE THIS ACTUALLY LIVES, said plainly because this docblock used to say
 * otherwise. The grants are a `WorkspaceStateStore` key, and that store is built
 * over `context.workspaceState` — a VS Code `Memento`, which the workbench keeps
 * in `<user-data-dir>/User/workspaceStorage/<hash>/state.vscdb`, a SQLite
 * database. There is no `.schegent/state.json`; nothing in this product has ever
 * written one. Five surfaces named that file and told operators to open and edit
 * it, which made FR-012's "observable and revocable" reachable only by a route
 * that does not exist. `commands/git-approvals.ts` is the route that does.
 */
export interface GitPlanGrant {
  readonly fingerprint: string;
  readonly grantedAt: number;
  readonly phaseIds: readonly string[];
  readonly pipelineId: string;
}

export type GitPlanGrantMap = Readonly<Record<string, GitPlanGrant>>;

/**
 * What `pipelineId` says when the plan could not name its pipeline.
 *
 * Only one snapshot can be in that state: one persisted by a build before
 * `MutationPlanSnapshot.pipelineId` existed, resumed after the upgrade. The
 * operator's answer is still theirs — consent binds the fingerprint, and losing
 * a legibility field must not cost them the grant they gave. Non-empty on
 * purpose, so `reject` accepts it and the entry survives the read.
 */
export const UNRECORDED_PIPELINE_ID = '(unrecorded)';

export interface GitPlanGrantsRead {
  readonly grants: GitPlanGrantMap;
  /** One message per rejection, for the caller to log. Empty on a clean read. */
  readonly problems: readonly string[];
}

/**
 * Bounds on operator-influenced input reaching a log line, mirroring
 * `backend-containment-policy.ts:169-177`. A state file someone hand-edited is as
 * long as they made it, and an unbounded echo turns a corrupt record into an
 * unbounded log write.
 */
const MAX_ECHOED_CHARS = 64;
const MAX_REPORTED_PROBLEMS = 10;

const EMPTY: GitPlanGrantMap = Object.freeze({});

const echo = (value: string): string =>
  value.length <= MAX_ECHOED_CHARS ? value : `${value.slice(0, MAX_ECHOED_CHARS)}… (truncated)`;

/**
 * Narrow a stored value into the grants it actually contains.
 *
 * `undefined` — the key absent — is the ordinary state of a fresh workspace and
 * reports nothing. Every other unusable value reports once, because a record that
 * exists and cannot be read is a fact about this workspace, not a default.
 */
export function readGitPlanGrants(raw: unknown): GitPlanGrantsRead {
  if (raw === undefined) return { grants: EMPTY, problems: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      grants: EMPTY,
      problems: [
        `the stored value is ${describe(raw)}, not a map of plan grants. No plan grant is in ` +
          'effect; every Git-mutating run will ask again.'
      ]
    };
  }

  const grants: Record<string, GitPlanGrant> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rejection = reject(key, value);
    if (rejection === null) {
      grants[key] = narrow(key, value as Record<string, unknown>);
      continue;
    }
    // Reporting stops; VALIDATION does not — the rule `resolveUncontainedGrant`
    // states at `:189-192`. A map larger than the report bound still yields
    // exactly the entries that are valid, so truncating the report can never
    // widen a grant.
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push(`dropped the grant stored under '${echo(key)}': ${rejection}`);
    }
  }
  return { grants, problems };
}

/**
 * The next map after recording one grant.
 *
 * Idempotent: re-approving a fingerprint already present overwrites it with a
 * fresh `grantedAt` and is not an error. Never widened by inference — a grant for
 * one fingerprint says nothing about any other, even one differing by a single
 * phase, which is the property FR-008 depends on.
 */
export function writeGitPlanGrant(current: GitPlanGrantMap, grant: GitPlanGrant): GitPlanGrantMap {
  return { ...current, [grant.fingerprint]: grant };
}

/**
 * FR-R3-146 (FR-012) — the map after withdrawing one grant.
 *
 * Returns `null` when the fingerprint is not present, so the caller can tell
 * "removed" from "there was nothing to remove" without comparing maps. That
 * distinction is the whole reason withdrawal has a return value: an operator who
 * asked to forget a grant and got a silent success would have no way to know
 * whether the grant they were looking at is gone or whether they were looking at
 * a stale list.
 *
 * `hasOwnProperty` rather than `in` or a truthiness test, for the reason
 * `hasGitPlanGrant` gives: a stored `toString` must not answer for a plan.
 */
export function forgetGitPlanGrant(
  current: GitPlanGrantMap,
  fingerprint: string
): GitPlanGrantMap | null {
  if (!Object.prototype.hasOwnProperty.call(current, fingerprint)) return null;
  const next: Record<string, GitPlanGrant> = { ...current };
  delete next[fingerprint];
  return next;
}

/** Why this entry cannot be used, or `null` if it can. */
function reject(key: string, value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `the entry is ${describe(value)}, not a grant record`;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.fingerprint !== 'string' || entry.fingerprint !== key) {
    // The key is authoritative: it is what a lookup will match on, so an entry
    // naming a different plan would grant consent for a plan nobody approved.
    return 'its `fingerprint` field does not equal the key it is stored under';
  }
  if (typeof entry.grantedAt !== 'number' || !Number.isFinite(entry.grantedAt)) {
    return '`grantedAt` is absent or is not a finite number';
  }
  if (typeof entry.pipelineId !== 'string' || entry.pipelineId.length === 0) {
    return '`pipelineId` is absent or is not a non-empty string';
  }
  if (!Array.isArray(entry.phaseIds) || !entry.phaseIds.every((id) => typeof id === 'string')) {
    return '`phaseIds` is not an array of strings';
  }
  return null;
}

/** Only ever called on a value `reject` has already accepted. */
function narrow(key: string, entry: Record<string, unknown>): GitPlanGrant {
  return {
    fingerprint: key,
    grantedAt: entry.grantedAt as number,
    pipelineId: entry.pipelineId as string,
    phaseIds: Object.freeze([...(entry.phaseIds as string[])])
  };
}

/** What the value is, in words a log line can carry, without echoing it. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
