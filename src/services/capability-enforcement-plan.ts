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
//
// FR-R4-F06 (FR-011 to FR-014; contract K; data-model section 3) — EVERY cell is declared. Each backend
// states, per capability it can withhold, the flags, HOW they enforce (a tool restriction the CLI
// applies to itself, or the vendor's own sandbox) and what it leaves open (residuals). A cell's outcome is
// composed from those declarations by one rule, and `capability-cell-declarations.test.ts` checks all 48
// cells against a table written out by hand. A withheld capability with any flag no capture has confirmed
// the installed CLI lists is refused and named `unqualified`; a flag nobody has seen is never relied on.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import {
  ALL_PHASE_CAPABILITIES,
  grants,
  type CapabilityEnforcement,
  type CapabilityResidual,
  type DeclaredCapabilitySet,
  type PhaseCapability
} from '../contracts/phase-capabilities';
import { CONFIRMED_FLAGS } from './capability-confirmed-flags';

export type CapabilityEnforcementPlan =
  | {
      readonly outcome: 'argv';
      readonly args: readonly string[];
      /** How the withheld capabilities are enforced; `none-withheld` when nothing is withheld. */
      readonly enforcement: CapabilityEnforcement;
      /** What the restriction still leaves open. Sorted, unique, and empty when nothing is. */
      readonly residuals: readonly CapabilityResidual[];
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'capability-not-enforceable';
      readonly kind: BackendRunnerKind;
      /** EVERY withheld capability the cell cannot enforce: no flag expresses it, or its flag is unconfirmed. */
      readonly unenforceable: readonly PhaseCapability[];
      /** The subset whose flag the planner declares and no capture has confirmed the installed CLI lists. */
      readonly unqualified: readonly PhaseCapability[];
    };

/** A flag name, with its value when it takes one. Pairing them means no token is judged a flag by its `-`. */
type FlagEntry = readonly [flag: string] | readonly [flag: string, value: string];

/** One capability a backend can withhold: the flags, how it enforces, and what it leaves open. */
interface WithholdDeclaration {
  /** Every flag the withholding needs. It applies all of them or, when one is unconfirmed, none. */
  readonly flags: readonly FlagEntry[];
  readonly enforcement: Exclude<CapabilityEnforcement, 'none-withheld'>;
  /** Left open whenever this capability is withheld. */
  readonly residuals: readonly CapabilityResidual[];
  /** Left open only while the keyed capability stays granted: a shell the restriction does not reach. */
  readonly residualsIfGranted?: Partial<Record<PhaseCapability, readonly CapabilityResidual[]>>;
}

/**
 * What each backend's CLI can express, re-derived from the installed binaries on
 * 2026-08-25 rather than assumed, and re-confirmed by flag name on 2026-10-31
 * (agy's `--mode` on 2026-11-06; `capability-confirmed-flags.ts`):
 *
 *   claude  --permission-mode, --allowedTools, --disallowedTools, --settings
 *   agy     --sandbox ("run in a sandbox with terminal restrictions"),
 *           --mode ("agent execution mode": accept-edits, auto, plan)
 *   codex   -s/--sandbox, -a/--ask-for-approval
 *
 * A capability absent from a backend's map is one that backend cannot enforce,
 * and a phase withholding it is refused rather than run unbounded.
 */
interface BackendSurface {
  /** The argv this backend spawns with when every capability is granted. */
  readonly unbounded: readonly string[];
  readonly withhold: Partial<Record<PhaseCapability, WithholdDeclaration>>;
}

const SURFACES: Readonly<Record<BackendRunnerKind, BackendSurface>> = {
  claude: {
    unbounded: ['--dangerously-skip-permissions'],
    withhold: {
      // `Bash` is the tool that spawns processes; denying it is the CLI's own
      // way of withholding that authority, and it refuses non-interactively.
      'process-spawn': {
        flags: [['--disallowedTools', 'Bash']],
        enforcement: 'tool-restriction',
        residuals: ['unlisted-tools']
      },
      // The network-reaching tools. A shell that stays granted reaches the network anyway.
      network: {
        flags: [['--disallowedTools', 'WebFetch,WebSearch']],
        enforcement: 'tool-restriction',
        residuals: ['unlisted-tools'],
        residualsIfGranted: { 'process-spawn': ['shell-network'] }
      },
      // Writing outside the workspace is what a non-bypass permission mode
      // stops. `acceptEdits` is non-interactive, so this does not become a
      // prompt — which principle I forbids.
      'outside-workspace-write': {
        flags: [['--permission-mode', 'acceptEdits']],
        enforcement: 'tool-restriction',
        residuals: ['unlisted-tools'],
        residualsIfGranted: { 'process-spawn': ['shell-outside-workspace-write'] }
      },
      'workspace-write': {
        flags: [['--disallowedTools', 'Edit,Write,NotebookEdit']],
        enforcement: 'tool-restriction',
        residuals: ['unlisted-tools'],
        residualsIfGranted: { 'process-spawn': ['shell-workspace-write'] }
      }
    }
  },
  agy: {
    unbounded: ['--dangerously-skip-permissions'],
    withhold: {
      // Agy's sandbox is documented as "terminal restrictions enabled", which is
      // the process-spawn boundary. Feature 280: headless at agy 1.5.2, `--sandbox`
      // alone also refused a file-tool write inside the workspace (follow-up probe
      // i), and adding `--mode accept-edits` let it through (j). A shell write was
      // refused by headless permissions (k), which says nothing about what the
      // sandbox confines, so its scope stays unqualified. This argv refused an
      // outside write (279's case d), a residual only while that write is granted.
      'process-spawn': {
        flags: [['--sandbox'], ['--mode', 'accept-edits']],
        enforcement: 'tool-restriction',
        residuals: ['sandbox-scope-unqualified'],
        residualsIfGranted: { 'outside-workspace-write': ['mode-refuses-outside-write'] }
      },
      // Feature 279: a non-bypass execution mode, like claude's `acceptEdits`.
      // Probed headless at agy 1.5.2 (specs/279-agy-accept-edits-mode/
      // measurements.md): it allows a file-tool write inside the workspace,
      // auto-denies one outside it and exits on its own, so it never prompts,
      // which principle I forbids. It also denied both shell commands probed,
      // which is a residual only while `process-spawn` stays granted. `workspace-write`
      // and `network` still have no expression here, so a phase withholding
      // either is refused rather than run unbounded;
      // `docs/architecture/agent-capability-posture.md` records that gap.
      'outside-workspace-write': {
        flags: [['--mode', 'accept-edits']],
        enforcement: 'tool-restriction',
        residuals: [],
        residualsIfGranted: { 'process-spawn': ['mode-refuses-shell'] }
      }
    }
  },
  codex: {
    // Already contained. Read from this one authority rather than restated at
    // the adapter, so the two cannot disagree.
    unbounded: ['--sandbox', 'workspace-write'],
    withhold: {
      'outside-workspace-write': {
        flags: [['--sandbox', 'workspace-write']],
        enforcement: 'cli-sandbox',
        residuals: []
      },
      'process-spawn': {
        flags: [['--sandbox', 'read-only']],
        enforcement: 'cli-sandbox',
        residuals: ['sandboxed-commands-run']
      },
      'workspace-write': {
        flags: [['--sandbox', 'read-only']],
        enforcement: 'cli-sandbox',
        residuals: []
      }
      // `network` has no flag on codex: no entry, so a set that withholds it is refused (K9).
    }
  }
};

/**
 * Flags whose value is a comma list, so two capabilities that share the flag merge into ONE occurrence. The
 * merge is the CLI's own documented form, so it asks nothing new of the parser. Only these flags merge:
 * any other valued flag that appears twice takes one value (see `FLAG_VALUE_STRICTNESS`).
 */
export const COMMA_LIST_FLAGS: ReadonlySet<string> = new Set(['--disallowedTools']);

/**
 * For a valued flag that is NOT a comma list, the values it can take, strictest first. Two capabilities that
 * give the same flag different values resolve to the strictest, because the stricter bound contains the other.
 * Codex's `--sandbox` is the one case: `read-only` beats `workspace-write`.
 *
 * FR-R4-F06 research R14 — the previous rule joined two `--sandbox` values with a comma
 * (`read-only,workspace-write`), which Codex does not accept; three Codex cells emitted it.
 */
export const FLAG_VALUE_STRICTNESS: Readonly<Partial<Record<string, readonly string[]>>> = Object.freeze({
  '--sandbox': ['read-only', 'workspace-write']
});

/** The stricter of two values of one flag; the first when either is not in the flag's ordering. */
function strictest(flag: string, current: string, incoming: string): string {
  const order = FLAG_VALUE_STRICTNESS[flag];
  if (order === undefined) return current;
  const currentRank = order.indexOf(current);
  const incomingRank = order.indexOf(incoming);
  if (currentRank === -1 || incomingRank === -1) return current;
  return incomingRank < currentRank ? incoming : current;
}

/**
 * Decide the argv for a backend under a declared capability set.
 *
 * The default set — every capability granted — produces `unbounded` exactly, so
 * a phase that declares nothing spawns with today's argv byte for byte.
 *
 * `confirmed` is the flags an installed CLI was shown to list (`CONFIRMED_FLAGS`). It is a parameter so a test
 * can ask what happens without a flag; production passes nothing.
 */
export function planCapabilityEnforcement(
  kind: BackendRunnerKind,
  declared: DeclaredCapabilitySet,
  confirmed: Readonly<Record<BackendRunnerKind, readonly string[]>> = CONFIRMED_FLAGS
): CapabilityEnforcementPlan {
  const surface = SURFACES[kind];
  const withheld = ALL_PHASE_CAPABILITIES.filter((capability) => !grants(declared, capability));

  if (withheld.length === 0) {
    return { outcome: 'argv', args: surface.unbounded, enforcement: 'none-withheld', residuals: [] };
  }

  // A capability the backend cannot express, and one it could express with a flag nobody has confirmed, are
  // different findings: the second is `unqualified`, and both are refused rather than run unbounded.
  // Every flag a declaration names, not only its first: one applied without the rest is not what was declared.
  const unqualified = withheld.filter((capability) => {
    const declaration = surface.withhold[capability];
    return declaration !== undefined && declaration.flags.some(([flag]) => !confirmed[kind].includes(flag));
  });
  const unenforceable = withheld.filter(
    (capability) => surface.withhold[capability] === undefined || unqualified.includes(capability)
  );
  if (unenforceable.length > 0) {
    // EVERY unenforceable capability, not the first. A refusal naming one of
    // three problems sends someone back twice.
    return { outcome: 'refused', reason: 'capability-not-enforceable', kind, unenforceable, unqualified };
  }

  // Compose the argv in capability order, deterministically, so the byte-identity test is not flaky.
  //
  // FR-R3-105 (FR-064) — the earlier form de-duplicated by `flags.join(' ')`, which only collapsed two
  // capabilities whose flag AND value were identical. Claude has three rows that share `--disallowedTools`
  // with different values, so withholding any two emitted the flag twice. WHY THAT WAS A SECURITY DEFECT:
  // the host does not control the child's argument parser. If it is last-wins — the common shape — then
  // `--disallowedTools Bash --disallowedTools WebFetch,WebSearch` silently RE-GRANTS Bash, on precisely the
  // most restrictive set anyone can request. So comma-list flags merge into one occurrence, and a valued flag
  // that is not a comma list takes ONE value, the strictest. The merge is only defined for `COMMA_LIST_FLAGS`;
  // a future flag that repeats with independent values would need a different answer, which is why that set
  // is explicit rather than assumed.
  const bare: string[] = [];
  /** Valued flags in the order first met. */
  const valuedOrder: string[] = [];
  const commaValues = new Map<string, string[]>();
  const singleValue = new Map<string, string>();
  const enforcements = new Set<CapabilityEnforcement>();
  const residuals = new Set<CapabilityResidual>();

  for (const capability of withheld) {
    const declaration = surface.withhold[capability];
    if (declaration === undefined) continue;
    enforcements.add(declaration.enforcement);
    for (const residual of declaration.residuals) residuals.add(residual);
    for (const [conditionCapability, conditional] of Object.entries(declaration.residualsIfGranted ?? {})) {
      if (grants(declared, conditionCapability as PhaseCapability)) {
        for (const residual of conditional) residuals.add(residual);
      }
    }

    for (const [flag, value] of declaration.flags) {
      if (value === undefined) {
        if (!bare.includes(flag)) bare.push(flag);
        continue;
      }
      if (!valuedOrder.includes(flag)) valuedOrder.push(flag);
      if (COMMA_LIST_FLAGS.has(flag)) {
        const existing = commaValues.get(flag) ?? [];
        for (const part of value.split(',')) if (!existing.includes(part)) existing.push(part);
        commaValues.set(flag, existing);
        continue;
      }
      const current = singleValue.get(flag);
      singleValue.set(flag, current === undefined ? value : strictest(flag, current, value));
    }
  }

  const args: string[] = [...bare];
  for (const flag of valuedOrder) {
    const merged = commaValues.get(flag);
    args.push(flag, merged !== undefined ? merged.join(',') : (singleValue.get(flag) ?? ''));
  }
  // A mixed cell reports the weaker claim: one tool restriction among sandboxes is still a tool restriction.
  const enforcement: CapabilityEnforcement = enforcements.has('tool-restriction')
    ? 'tool-restriction'
    : 'cli-sandbox';
  return { outcome: 'argv', args, enforcement, residuals: [...residuals].sort() };
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
