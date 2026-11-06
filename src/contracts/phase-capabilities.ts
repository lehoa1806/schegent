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
// backend-enforced restriction (CLI tool restrictions and vendor sandboxes), driven
// by a host-declared capability set. The host DECLARES; the backend ENFORCES. All three installed CLIs carry a real
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

/**
 * FR-R4-F06 (FR-012, FR-013; contract K; data-model section 3) -- how a cell's withheld capabilities are
 * enforced, in the words an operator needs to weigh the claim.
 *
 * - `none-withheld`: nothing was withheld, so nothing is enforced and the backend's argv is unchanged.
 * - `tool-restriction`: the CLI's own tool layer applies a denylist to itself. It is not OS isolation.
 * - `cli-sandbox`: the vendor's own sandbox (`codex --sandbox`, `agy --sandbox`), which the vendor claims
 *   sits below the tool layer. The qualification record qualifies the flag's presence, not that claim.
 *
 * A cell that mixes classes reports the weaker one, `tool-restriction`.
 */
export type CapabilityEnforcement = 'none-withheld' | 'tool-restriction' | 'cli-sandbox';

/**
 * FR-R4-F06 (FR-012; contract K; data-model section 3) -- what a restriction still leaves open. Closed, so
 * the audit payload and the launcher sentence can both be exhaustive over it.
 */
export type CapabilityResidual =
  /** `network` withheld while `process-spawn` is granted (claude): a shell can still reach the network. */
  | 'shell-network'
  /** `workspace-write` withheld while `process-spawn` is granted (claude): a shell can still write. */
  | 'shell-workspace-write'
  /** `outside-workspace-write` withheld while `process-spawn` is granted (claude). */
  | 'shell-outside-workspace-write'
  /** Any claude withholding: tools the denylist does not name, including extension and MCP tools. */
  | 'unlisted-tools'
  /** `process-spawn` withheld on codex: model-run commands still execute, inside its sandbox. */
  | 'sandboxed-commands-run'
  /** `process-spawn` withheld on agy: the scope of its sandbox has not been qualified. */
  | 'sandbox-scope-unqualified'
  /**
   * `outside-workspace-write` withheld on agy while `process-spawn` is granted: `--mode accept-edits`
   * denies shell commands headless unless agy's own permission settings allow them. A stricter side
   * effect, disclosed like codex's `sandboxed-commands-run`.
   */
  | 'mode-refuses-shell'
  /**
   * `process-spawn` withheld on agy while `outside-workspace-write` is granted: the cell adds
   * `--mode accept-edits` so file tools can write inside the workspace, and that mode refuses a write
   * outside it unless agy's own permission settings allow it. Stricter than the Phase asked.
   */
  | 'mode-refuses-outside-write';
