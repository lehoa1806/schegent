import { describe, expect, it } from 'vitest';

import {
  ALL_PHASE_CAPABILITIES,
  declaredCapabilitySet,
  type PhaseCapability
} from '../../../src/contracts/phase-capabilities';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { planCapabilityEnforcement, unboundedArgs } from '../../../src/services/capability-enforcement-plan';

/**
 * FR-R4-F06 (FR-011, FR-013, FR-014, SC-004; T10; contract K, K1, K2, K7 and K9) -- every one of the 48
 * capability cells has a declared outcome, checked against a table written out by hand.
 *
 * WHY A LITERAL TABLE. The planner builds each cell from per-capability declarations by a composition rule
 * (merge the comma-list flags, take the strictest `--sandbox`, emit bare flags once). A test that built its
 * expectation from the same declarations would agree with the planner about everything, including its
 * mistakes. So the expectation is 48 rows worked out from data-model section 3 by hand, one per
 * (backend, granted set). This file imports nothing from the planner but `planCapabilityEnforcement` and
 * `unboundedArgs` (which K7 pins the three no-restriction rows to), and it iterates the POWER SET of
 * capabilities rather than the table, so a deleted row fails by name instead of being skipped.
 *
 * WHAT THE CENSUS SAYS (data-model section 3): 26 cells yield an argv, 3 of them with nothing withheld,
 * and 22 are refused. Claude yields an argv for all 16 sets. Codex yields one only when `network` is
 * granted (8), because its CLI has no flag for it, and refuses the other 8. Agy yields one only when
 * nothing, or only `process-spawn`, is withheld (2), and refuses the other 14.
 *
 * THE THREE CODEX CELLS OF RESEARCH R14 are the sets that withhold `outside-workspace-write` together with
 * `workspace-write` or `process-spawn`. They used to emit `--sandbox` twice, merged into the value
 * `read-only,workspace-write`, which Codex does not accept. They now emit the strictest single value.
 *
 * Controls: M6 (merge `--sandbox` values as a comma list again), M7 (drop `shell-network` from Claude's
 * `network` declaration) and M8 (delete one row) each turn this file red.
 */
const W: PhaseCapability = 'workspace-write';
const O: PhaseCapability = 'outside-workspace-write';
const P: PhaseCapability = 'process-spawn';
const N: PhaseCapability = 'network';

type Enforcement = 'none-withheld' | 'tool-restriction' | 'cli-sandbox';

interface ArgvRow {
  readonly kind: BackendRunnerKind;
  readonly granted: readonly PhaseCapability[];
  readonly outcome: 'argv';
  readonly args: readonly string[];
  readonly enforcement: Enforcement;
  readonly residuals: readonly string[];
}
interface RefusedRow {
  readonly kind: BackendRunnerKind;
  readonly granted: readonly PhaseCapability[];
  readonly outcome: 'refused';
  readonly unenforceable: readonly PhaseCapability[];
  readonly unqualified: readonly PhaseCapability[];
}
type Row = ArgvRow | RefusedRow;

const DISALLOW = '--disallowedTools';
const MODE = '--permission-mode';
const UNBOUNDED_CLAUDE = ['--dangerously-skip-permissions'];
const UNBOUNDED_CODEX = ['--sandbox', 'workspace-write'];

const claude = (
  granted: readonly PhaseCapability[],
  args: readonly string[],
  residuals: readonly string[],
  enforcement: Enforcement = 'tool-restriction'
): ArgvRow => ({ kind: 'claude', granted, outcome: 'argv', args, enforcement, residuals });

const codex = (
  granted: readonly PhaseCapability[],
  args: readonly string[],
  residuals: readonly string[],
  enforcement: Enforcement = 'cli-sandbox'
): ArgvRow => ({ kind: 'codex', granted, outcome: 'argv', args, enforcement, residuals });

const codexRefused = (granted: readonly PhaseCapability[]): RefusedRow => ({
  kind: 'codex',
  granted,
  outcome: 'refused',
  unenforceable: [N],
  unqualified: []
});

const agyRefused = (
  granted: readonly PhaseCapability[],
  unenforceable: readonly PhaseCapability[]
): RefusedRow => ({ kind: 'agy', granted, outcome: 'refused', unenforceable, unqualified: [] });

/** The 48 rows. `granted` is in capability order: W, O, P, N. */
const GOLDEN: readonly Row[] = [
  // ---- claude: 16 argv cells. Bare flags first, then valued flags in the order first met; --disallowedTools
  //      values merge in capability order. A shell-reaching residual holds only while `process-spawn` is granted.
  claude([W, O, P, N], UNBOUNDED_CLAUDE, [], 'none-withheld'),
  claude([O, P, N], [DISALLOW, 'Edit,Write,NotebookEdit'], ['shell-workspace-write', 'unlisted-tools']),
  claude([W, P, N], [MODE, 'acceptEdits'], ['shell-outside-workspace-write', 'unlisted-tools']),
  claude([W, O, N], [DISALLOW, 'Bash'], ['unlisted-tools']),
  claude([W, O, P], [DISALLOW, 'WebFetch,WebSearch'], ['shell-network', 'unlisted-tools']),
  claude(
    [P, N],
    [DISALLOW, 'Edit,Write,NotebookEdit', MODE, 'acceptEdits'],
    ['shell-outside-workspace-write', 'shell-workspace-write', 'unlisted-tools']
  ),
  claude([O, N], [DISALLOW, 'Edit,Write,NotebookEdit,Bash'], ['unlisted-tools']),
  claude(
    [O, P],
    [DISALLOW, 'Edit,Write,NotebookEdit,WebFetch,WebSearch'],
    ['shell-network', 'shell-workspace-write', 'unlisted-tools']
  ),
  claude([W, N], [MODE, 'acceptEdits', DISALLOW, 'Bash'], ['unlisted-tools']),
  claude(
    [W, P],
    [MODE, 'acceptEdits', DISALLOW, 'WebFetch,WebSearch'],
    ['shell-network', 'shell-outside-workspace-write', 'unlisted-tools']
  ),
  claude([W, O], [DISALLOW, 'Bash,WebFetch,WebSearch'], ['unlisted-tools']),
  claude([N], [DISALLOW, 'Edit,Write,NotebookEdit,Bash', MODE, 'acceptEdits'], ['unlisted-tools']),
  claude(
    [P],
    [DISALLOW, 'Edit,Write,NotebookEdit,WebFetch,WebSearch', MODE, 'acceptEdits'],
    ['shell-network', 'shell-outside-workspace-write', 'shell-workspace-write', 'unlisted-tools']
  ),
  claude([O], [DISALLOW, 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch'], ['unlisted-tools']),
  claude([W], [MODE, 'acceptEdits', DISALLOW, 'Bash,WebFetch,WebSearch'], ['unlisted-tools']),
  claude([], [DISALLOW, 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch', MODE, 'acceptEdits'], ['unlisted-tools']),

  // ---- codex: 8 argv cells (every set granting `network`) and 8 refusals. One `--sandbox` value, the strictest.
  codex([W, O, P, N], UNBOUNDED_CODEX, [], 'none-withheld'),
  codex([O, P, N], ['--sandbox', 'read-only'], []),
  codex([W, P, N], ['--sandbox', 'workspace-write'], []),
  codex([W, O, N], ['--sandbox', 'read-only'], ['sandboxed-commands-run']),
  codex([P, N], ['--sandbox', 'read-only'], []), // R14: withholds W and O
  codex([O, N], ['--sandbox', 'read-only'], ['sandboxed-commands-run']),
  codex([W, N], ['--sandbox', 'read-only'], ['sandboxed-commands-run']), // R14: withholds O and P
  codex([N], ['--sandbox', 'read-only'], ['sandboxed-commands-run']), // R14: withholds W, O and P
  codexRefused([W, O, P]),
  codexRefused([W, O]),
  codexRefused([W, P]),
  codexRefused([O, P]),
  codexRefused([W]),
  codexRefused([O]),
  codexRefused([P]),
  codexRefused([]),

  // ---- agy: 2 argv cells (nothing withheld, or only `process-spawn`) and 14 refusals, each naming everything
  //      it cannot express.
  {
    kind: 'agy',
    granted: [W, O, P, N],
    outcome: 'argv',
    args: UNBOUNDED_CLAUDE,
    enforcement: 'none-withheld',
    residuals: []
  },
  {
    kind: 'agy',
    granted: [W, O, N],
    outcome: 'argv',
    args: ['--sandbox'],
    enforcement: 'cli-sandbox',
    residuals: ['sandbox-scope-unqualified']
  },
  agyRefused([W, O, P], [N]),
  agyRefused([W, P, N], [O]),
  agyRefused([O, P, N], [W]),
  agyRefused([W, O], [N]),
  agyRefused([W, P], [O, N]),
  agyRefused([W, N], [O]),
  agyRefused([O, P], [W, N]),
  agyRefused([O, N], [W]),
  agyRefused([P, N], [W, O]),
  agyRefused([W], [O, N]),
  agyRefused([O], [W, N]),
  agyRefused([P], [W, O, N]),
  agyRefused([N], [W, O]),
  agyRefused([], [W, O, N])
];

const keyOf = (kind: BackendRunnerKind, granted: readonly PhaseCapability[]): string =>
  `${kind}|${ALL_PHASE_CAPABILITIES.filter((c) => granted.includes(c)).join(',')}`;

/** Every subset of the four capabilities, each in capability order. */
function powerSet(): PhaseCapability[][] {
  const sets: PhaseCapability[][] = [];
  for (let mask = 0; mask < 1 << ALL_PHASE_CAPABILITIES.length; mask += 1) {
    sets.push(ALL_PHASE_CAPABILITIES.filter((_c, index) => (mask & (1 << index)) !== 0));
  }
  return sets;
}

const BY_KEY = new Map(GOLDEN.map((row) => [keyOf(row.kind, row.granted), row]));

describe('every capability cell is declared (T10)', () => {
  it('has 48 distinct rows, one per backend and granted set', () => {
    expect(GOLDEN).toHaveLength(48);
    expect(BY_KEY.size, 'two rows share a key, so one cell is described twice and another not at all').toBe(48);
    expect(SUPPORTED_BACKENDS.length * powerSet().length).toBe(48);
  });

  it('has the census of data-model section 3: 26 argv cells, 3 with nothing withheld, and 22 refusals', () => {
    const argv = GOLDEN.filter((row): row is ArgvRow => row.outcome === 'argv');
    expect(argv).toHaveLength(26);
    expect(argv.filter((row) => row.enforcement === 'none-withheld')).toHaveLength(3);
    expect(GOLDEN.filter((row) => row.outcome === 'refused')).toHaveLength(22);
    for (const kind of SUPPORTED_BACKENDS) {
      expect(argv.filter((row) => row.kind === kind).length).toBe({ claude: 16, codex: 8, agy: 2 }[kind]);
    }
  });

  describe.each(SUPPORTED_BACKENDS)('%s', (kind) => {
    it.each(powerSet().map((granted) => [granted.join(', ') || 'nothing', granted] as const))(
      'grants %s',
      (_label, granted) => {
        const row = BY_KEY.get(keyOf(kind, granted));
        expect(row, `no golden row for ${keyOf(kind, granted)}`).toBeDefined();
        if (row === undefined) return;

        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(granted));

        expect(plan.outcome).toBe(row.outcome);
        if (row.outcome === 'argv') {
          expect(plan.outcome === 'argv' && plan.args).toEqual(row.args);
          expect(plan.outcome === 'argv' && plan.enforcement).toBe(row.enforcement);
          expect(plan.outcome === 'argv' && plan.residuals).toEqual(row.residuals);
        } else {
          expect(plan.outcome === 'refused' && plan.unenforceable).toEqual(row.unenforceable);
          expect(plan.outcome === 'refused' && plan.unqualified).toEqual(row.unqualified);
          expect(plan.outcome === 'refused' && plan.kind).toBe(kind);
        }
      }
    );
  });

  it('gives the three Codex cells of research R14 the single strictest value, never a merged one', () => {
    const cells = [[P, N], [W, N], [N]] as const;
    for (const granted of cells) {
      const row = BY_KEY.get(keyOf('codex', granted));
      expect(row?.outcome === 'argv' && row.args).toEqual(['--sandbox', 'read-only']);
      const plan = planCapabilityEnforcement('codex', declaredCapabilitySet(granted));
      expect(plan.outcome === 'argv' && plan.args.join(' ')).not.toContain(',');
    }
  });

  it('emits no flag twice and no comma in any --sandbox value, in any argv cell (K2)', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (const granted of powerSet()) {
        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(granted));
        if (plan.outcome !== 'argv') continue;
        const flags = plan.args.filter((arg) => arg.startsWith('--'));
        expect(new Set(flags).size, `${keyOf(kind, granted)} repeats a flag`).toBe(flags.length);
        const sandboxValue = plan.args.at(plan.args.indexOf('--sandbox') + 1);
        if (plan.args.includes('--sandbox') && sandboxValue !== undefined) {
          expect(sandboxValue).not.toContain(',');
        }
      }
    }
  });

  it('keeps the three no-restriction rows byte-identical to the unrestricted argv (K7)', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(ALL_PHASE_CAPABILITIES));
      expect(plan.outcome === 'argv' && plan.args).toEqual(unboundedArgs(kind));
      expect(plan.outcome === 'argv' && plan.enforcement).toBe('none-withheld');
      expect(plan.outcome === 'argv' && plan.residuals).toEqual([]);
    }
  });

  it('refuses Agy and Codex exactly where their CLIs have no flag, and names every one (K9)', () => {
    const agy = planCapabilityEnforcement('agy', declaredCapabilitySet([]));
    expect(agy.outcome === 'refused' && agy.unenforceable).toEqual([W, O, N]);
    const codexNoNetwork = planCapabilityEnforcement('codex', declaredCapabilitySet([W, O, P]));
    expect(codexNoNetwork.outcome === 'refused' && codexNoNetwork.unenforceable).toEqual([N]);
  });

  it('is deterministic: the same set always yields the same cell', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (const granted of powerSet()) {
        const set = declaredCapabilitySet(granted);
        expect(planCapabilityEnforcement(kind, set)).toEqual(planCapabilityEnforcement(kind, set));
      }
    }
  });
});

describe('a flag nobody has seen is refused, and named as unqualified (T10, K3)', () => {
  /** The capture's list, with one flag removed: the planner is asked what it does without it. */
  const without = (kind: BackendRunnerKind, flag: string): Readonly<Record<BackendRunnerKind, readonly string[]>> => {
    const all: Record<BackendRunnerKind, readonly string[]> = {
      claude: ['--dangerously-skip-permissions', DISALLOW, MODE],
      codex: ['--sandbox'],
      agy: ['--dangerously-skip-permissions', '--sandbox']
    };
    return { ...all, [kind]: all[kind].filter((confirmed) => confirmed !== flag) };
  };

  it('refuses a Claude cell whose --disallowedTools was not confirmed, listing it as both', () => {
    const plan = planCapabilityEnforcement('claude', declaredCapabilitySet([O, P, N]), without('claude', DISALLOW));
    expect(plan.outcome).toBe('refused');
    expect(plan.outcome === 'refused' && plan.unenforceable).toEqual([W]);
    expect(plan.outcome === 'refused' && plan.unqualified).toEqual([W]);
  });

  it('lists only the capabilities whose flag is missing, and still runs the ones whose flag was confirmed', () => {
    // [W, P] granted withholds O (--permission-mode, confirmed) and N (--disallowedTools, not).
    const plan = planCapabilityEnforcement('claude', declaredCapabilitySet([W, P]), without('claude', DISALLOW));
    expect(plan.outcome === 'refused' && plan.unenforceable).toEqual([N]);
    expect(plan.outcome === 'refused' && plan.unqualified).toEqual([N]);

    // [W, P, N] granted withholds only O, whose flag was confirmed: the same cell is still an argv.
    const fine = planCapabilityEnforcement('claude', declaredCapabilitySet([W, P, N]), without('claude', DISALLOW));
    expect(fine.outcome).toBe('argv');
  });

  it('keeps "cannot express" and "has not been seen" apart in one refusal', () => {
    // Codex, nothing granted: network has no declaration (cannot express); with --sandbox unconfirmed
    // the other three have a declaration whose flag nobody saw (unqualified). All four are unenforceable.
    const plan = planCapabilityEnforcement('codex', declaredCapabilitySet([]), without('codex', '--sandbox'));
    expect(plan.outcome === 'refused' && plan.unenforceable).toEqual([W, O, P, N]);
    expect(plan.outcome === 'refused' && plan.unqualified).toEqual([W, O, P]);
  });

  it('never refuses the no-restriction cell for an unconfirmed capability flag', () => {
    const plan = planCapabilityEnforcement('claude', declaredCapabilitySet(ALL_PHASE_CAPABILITIES), without('claude', DISALLOW));
    expect(plan.outcome).toBe('argv');
  });

  it('uses the capture\'s transcription unless told otherwise, and that leaves unqualified empty everywhere', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (const granted of powerSet()) {
        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(granted));
        if (plan.outcome === 'refused') expect(plan.unqualified, keyOf(kind, granted)).toEqual([]);
      }
    }
  });
});
