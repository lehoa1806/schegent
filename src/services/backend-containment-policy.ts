import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../runner/backend-runner-factory';

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

/** Backends whose argv carries no OS-enforced bound. */
const UNCONTAINED: ReadonlySet<BackendRunnerKind> = new Set<BackendRunnerKind>([
  // `--dangerously-skip-permissions`: approval prompts off, no filesystem bound.
  'claude',
  'agy'
]);

export type BackendContainment = 'os-enforced' | 'none';

export function containmentOf(kind: BackendRunnerKind): BackendContainment {
  return UNCONTAINED.has(kind) ? 'none' : 'os-enforced';
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

/** The setting an operator sets to accept the uncontained posture. */
export const ALLOW_UNCONTAINED_SETTING = 'schegent.backend.allowUncontainedBackends';

/**
 * May this backend run?
 *
 * A pure function of the backend and one boolean, so the decision is testable
 * without a workspace, a CLI, or a spawn — and so both the admission check and
 * the spawn-time check read the same answer instead of each implementing it.
 */
export function judgeBackendContainment(
  kind: BackendRunnerKind,
  allowUncontained: boolean
): ContainmentVerdict {
  const containment = containmentOf(kind);
  if (containment === 'os-enforced' || allowUncontained) {
    return { outcome: 'allowed', containment };
  }
  return {
    outcome: 'refused',
    reason: 'uncontained-backend-not-enabled',
    kind,
    // Names the setting and the alternative. A refusal an operator cannot act on
    // is a refusal they will work around.
    message:
      `The '${kind}' backend runs without an OS-enforced bound on what it can reach. ` +
      `Set '${ALLOW_UNCONTAINED_SETTING}' to true to accept that, or choose a backend ` +
      'that carries a sandbox. See docs/architecture/agent-capability-posture.md.'
  };
}
