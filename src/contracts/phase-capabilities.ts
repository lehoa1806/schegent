// FR-R3-086 (H-01 / SEC-08) — what an agent may do during a phase.
//
// WHAT SHIPPED BEFORE THIS, and why it was not enough. `FR-R3-056` chose shape
// 3: a fresh install refuses its first run with an uncontained backend, and the
// opt-in is an application-scoped setting recorded per run. That is real and it
// is not weakened here. But it gates whether an agent may START. After the
// opt-in there was no per-tool boundary at all — the agent held the OS user's
// full authority for the length of the phase. `56` §5 says it plainly: shape 2
// "is the only shape that bounds `claude` itself rather than gating whether it
// may run at all".
//
// THE ROUTE TAKEN, recorded in docs/architecture/agent-capability-posture.md:
// OS/CLI-enforced containment driven by a host-declared capability set. The host
// DECLARES; the backend ENFORCES. All three installed CLIs carry a real
// enforcement surface — `claude` has `--permission-mode`, `--allowedTools` and
// `--disallowedTools`; `agy` has `--sandbox` and `--mode`; `codex` already runs
// with `--sandbox workspace-write` — so this is not a compromise route, it is the
// one that reaches the point of effect without building a mediator process
// inside the expansion freeze.
//
// THE LIMIT, stated here and in the threat model rather than left to be found:
// the host does not observe each tool call. It hands the backend a narrowed
// authority and trusts the backend to apply it. That is a trust anchor, not a
// claim this feature proves. A containment claim without its limits is the R-14
// class.

/**
 * The capability union. **Closed on purpose**: the enforcement plan must be
 * exhaustive over it, and the audit payload must be a closed union — the same
 * discipline every other audit payload in this contract follows.
 */
export type PhaseCapability =
  | 'workspace-write'
  | 'outside-workspace-write'
  | 'process-spawn'
  | 'network';

export const ALL_PHASE_CAPABILITIES: ReadonlyArray<PhaseCapability> = Object.freeze([
  'workspace-write',
  'outside-workspace-write',
  'process-spawn',
  'network'
]);

export function isPhaseCapability(value: unknown): value is PhaseCapability {
  return typeof value === 'string' && (ALL_PHASE_CAPABILITIES as readonly string[]).includes(value);
}

export interface DeclaredCapabilitySet {
  readonly capabilities: ReadonlyArray<PhaseCapability>;
  /**
   * Where the set came from. `'default'` means the phase declared nothing, which
   * is the overwhelmingly common case and must behave exactly as it did before
   * this contract existed.
   */
  readonly declaredAt: 'phase-definition' | 'default';
}

/**
 * Every capability.
 *
 * **This is load-bearing.** A phase that declares nothing gets this set, and the
 * enforcement plan turns it into the argv that backend spawns with TODAY, byte
 * for byte. Nothing about any existing run changes shape, the
 * `--dangerously-skip-permissions` disclosure stays true, and FR-R3-056's
 * refusal default is untouched. Narrowing is opt-in, per phase.
 */
export const DEFAULT_CAPABILITY_SET: DeclaredCapabilitySet = Object.freeze({
  capabilities: ALL_PHASE_CAPABILITIES,
  declaredAt: 'default' as const
});

/** A declared set from a Phase definition, normalised and frozen. */
export function declaredCapabilitySet(
  capabilities: readonly PhaseCapability[]
): DeclaredCapabilitySet {
  return Object.freeze({
    capabilities: Object.freeze(
      ALL_PHASE_CAPABILITIES.filter((capability) => capabilities.includes(capability))
    ),
    declaredAt: 'phase-definition' as const
  });
}

export function grants(set: DeclaredCapabilitySet, capability: PhaseCapability): boolean {
  return set.capabilities.includes(capability);
}
