// FR-R3-086 — turn a declared capability set into the argv a backend enforces,
// or into a refusal that names what it cannot enforce.
//
// PURE. No I/O, no environment reads, no clock. That is what lets it be tested
// exhaustively over three backends x the capability power set, which is the
// difference between a mechanism and a claim about one.
//
// ENFORCEMENT AT THE POINT OF EFFECT, and what that means here. The host does
// not intercept tool calls. It narrows the authority the backend grants itself,
// so the backend's own permission engine refuses at the attempt. Where a backend
// has no surface that can express a withheld capability, the phase is REFUSED
// BEFORE IT STARTS rather than run with the set silently ignored. A phase that
// proceeds unbounded while a narrower set was approved is the fence problem
// again, and it is the failure this whole round has been about.
//
// NEVER A PROMPTING MODE. Constitution principle I forbids an interactive halt:
// Schegent spawns without a TTY and a prompt deadlocks the orchestrator. So a
// capability that could only be enforced by asking a human is treated as
// UNENFORCEABLE, not as a prompt. `capability-enforcement-plan.test.ts` asserts
// no translation ever emits one.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import {
  ALL_PHASE_CAPABILITIES,
  grants,
  type DeclaredCapabilitySet,
  type PhaseCapability
} from '../contracts/phase-capabilities';

export type CapabilityEnforcementPlan =
  | { readonly outcome: 'argv'; readonly args: readonly string[] }
  | {
      readonly outcome: 'refused';
      readonly reason: 'capability-not-enforceable';
      readonly kind: BackendRunnerKind;
      readonly unenforceable: readonly PhaseCapability[];
    };

/**
 * What each backend's CLI can express, re-derived from the installed binaries on
 * 2026-08-25 rather than assumed:
 *
 *   claude  --permission-mode, --allowedTools, --disallowedTools, --settings
 *   agy     --sandbox ("run in a sandbox with terminal restrictions"), --mode
 *   codex   -s/--sandbox, -a/--ask-for-approval
 *
 * A capability absent from a backend's map is one that backend cannot enforce,
 * and a phase withholding it is refused rather than run unbounded.
 */
interface BackendSurface {
  /** The argv this backend spawns with when every capability is granted. */
  readonly unbounded: readonly string[];
  /**
   * Flags that WITHHOLD a capability. Ordered so the emitted argv is stable — an
   * unstable argv would make the byte-identity test flaky for no reason.
   */
  readonly withhold: Partial<Record<PhaseCapability, readonly string[]>>;
}

const SURFACES: Readonly<Record<BackendRunnerKind, BackendSurface>> = {
  claude: {
    unbounded: ['--dangerously-skip-permissions'],
    withhold: {
      // `Bash` is the tool that spawns processes; denying it is the CLI's own
      // way of withholding that authority, and it refuses non-interactively.
      'process-spawn': ['--disallowedTools', 'Bash'],
      // The network-reaching tools.
      network: ['--disallowedTools', 'WebFetch,WebSearch'],
      // Writing outside the workspace is what a non-bypass permission mode
      // stops. `acceptEdits` is non-interactive, so this does not become a
      // prompt — which principle I forbids.
      'outside-workspace-write': ['--permission-mode', 'acceptEdits'],
      'workspace-write': ['--disallowedTools', 'Edit,Write,NotebookEdit']
    }
  },
  agy: {
    unbounded: ['--dangerously-skip-permissions'],
    withhold: {
      // Agy's sandbox is documented as "terminal restrictions enabled", which is
      // the process-spawn boundary. It has no per-tool flag, so the other three
      // capabilities have NO expression on this backend — a phase withholding one
      // is refused rather than run unbounded. That gap is the honest finding, and
      // `docs/architecture/agent-capability-posture.md` records it.
      'process-spawn': ['--sandbox']
    }
  },
  codex: {
    // Already contained. Read from this one authority rather than restated at
    // the adapter, so the two cannot disagree.
    unbounded: ['--sandbox', 'workspace-write'],
    withhold: {
      'outside-workspace-write': ['--sandbox', 'workspace-write'],
      'process-spawn': ['--sandbox', 'read-only'],
      'workspace-write': ['--sandbox', 'read-only']
    }
  }
};

/**
 * Decide the argv for a backend under a declared capability set.
 *
 * The default set — every capability granted — produces `unbounded` exactly, so
 * a phase that declares nothing spawns with today's argv byte for byte.
 */
export function planCapabilityEnforcement(
  kind: BackendRunnerKind,
  declared: DeclaredCapabilitySet
): CapabilityEnforcementPlan {
  const surface = SURFACES[kind];
  const withheld = ALL_PHASE_CAPABILITIES.filter((capability) => !grants(declared, capability));

  if (withheld.length === 0) {
    return { outcome: 'argv', args: surface.unbounded };
  }

  const unenforceable = withheld.filter((capability) => surface.withhold[capability] === undefined);
  if (unenforceable.length > 0) {
    // EVERY unenforceable capability, not the first. A refusal naming one of
    // three problems sends someone back twice.
    return { outcome: 'refused', reason: 'capability-not-enforceable', kind, unenforceable };
  }

  // Emit in capability order so the argv is deterministic, de-duplicating flags
  // two capabilities happen to share (codex's sandbox modes overlap by design).
  const args: string[] = [];
  const seen = new Set<string>();
  for (const capability of withheld) {
    const flags = surface.withhold[capability];
    if (flags === undefined) continue;
    const token = flags.join(' ');
    if (seen.has(token)) continue;
    seen.add(token);
    args.push(...flags);
  }
  return { outcome: 'argv', args };
}

/** The capabilities a backend can express. Exported so a gate can enumerate. */
export function enforceableCapabilities(kind: BackendRunnerKind): readonly PhaseCapability[] {
  return ALL_PHASE_CAPABILITIES.filter(
    (capability) => SURFACES[kind].withhold[capability] !== undefined
  );
}

/** The argv a backend spawns with when nothing is withheld. */
export function unboundedArgs(kind: BackendRunnerKind): readonly string[] {
  return SURFACES[kind].unbounded;
}
