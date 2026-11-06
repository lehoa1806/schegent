import { describe, expect, it } from 'vitest';

import {
  ALL_PHASE_CAPABILITIES,
  declaredCapabilitySet,
  type PhaseCapability
} from '../../../src/contracts/phase-capabilities';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
import { describeCapabilityOutcome } from '../../../src/services/capability-disclosure';
import { planCapabilityEnforcement } from '../../../src/services/capability-enforcement-plan';

/**
 * FR-R4-F06 (FR-012, FR-013; T12; contract K, K4) -- the sentences the host shows for a capability set.
 *
 * WHAT THEY MUST DO. Say what kind of thing enforces the restriction, say what it leaves open, and never
 * call a tool denial OS containment. A Claude restriction is the CLI's tool layer applying a denylist to
 * itself; a shell the model is allowed to run can still do what the denied tool would have done, where the
 * backend's own permission settings let it. So every sentence OPENS with its class in words, and every
 * residual has one fixed clause, conditional wherever the outcome depends on the backend's own settings.
 *
 * ONLY ONE PIECE OF TEXT IS NOT FIXED: the Phase's name, which the catalog has already sanitized and
 * capped. The tests use a name that is not a constant, and assert nothing else moves.
 *
 * L5 (`tests/lint/capability-wording.test.ts`) forbids "network/filesystem containment/isolation/sandbox"
 * in a capability context. This file runs its pattern over every sentence the module can produce.
 */
const TOOL_CLASS = 'a tool-access restriction, not OS isolation';
const SANDBOX_CLASS = "the CLI's own sandbox";
/** The L5 pattern, restated so a sentence is checked against the rule the gate enforces. */
const FORBIDDEN = /(network|filesystem)\s+(containment|isolation|sandbox)/i;

const CLAUSES = {
  'shell-network':
    "a granted shell can still reach the network where the backend's own permission settings let it run",
  'shell-workspace-write':
    "a granted shell can still write workspace files where the backend's own permission settings let it run",
  'shell-outside-workspace-write':
    "a granted shell can still write outside the workspace where the backend's own permission settings let it run",
  'unlisted-tools':
    'tools the restriction does not name, including tools from configured extensions or MCP servers, are not covered',
  // FR-R4-F06 (FR-012; research R14, R15) -- read-only is the strictest Codex mode and it also blocks file
  // writes, so a set that grants a write and withholds process-spawn runs without the write it granted.
  // The clause says so, because the sentence is the only place an operator at the launcher would see it.
  'sandboxed-commands-run':
    "model-run commands still execute, inside Codex's read-only sandbox, which also blocks file writes",
  'sandbox-scope-unqualified': "the scope of Agy's sandbox has not been qualified",
  // Feature 279 (FR-011; research R4) -- the headless probe saw `--mode accept-edits` deny every shell
  // command, inside the workspace or not, with agy settings that hold no allow-rule for it. An allow-rule
  // would let the shell run, so the clause stays conditional on the backend's own settings.
  'mode-refuses-shell':
    "a granted shell is refused by Agy's accept-edits mode unless the backend's own permission settings allow it, and where they do it can still write outside the workspace"
} as const;

const NAME = 'Implement the plan';

const planOf = (kind: 'claude' | 'codex' | 'agy', granted: readonly PhaseCapability[]) =>
  planCapabilityEnforcement(kind, declaredCapabilitySet(granted));

describe('the host sentence for a capability outcome (T12)', () => {
  it('says nothing for a plan with nothing withheld', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      expect(describeCapabilityOutcome(planOf(kind, ALL_PHASE_CAPABILITIES), NAME)).toBeNull();
    }
  });

  it('says nothing for an argv plan with no residuals', () => {
    // Codex withholding workspace-write: the CLI's sandbox carries it whole.
    const plan = planOf('codex', ['outside-workspace-write', 'process-spawn', 'network']);
    expect(plan.outcome === 'argv' && plan.residuals).toEqual([]);
    expect(describeCapabilityOutcome(plan, NAME)).toBeNull();
  });

  it('opens a tool restriction with its class, and names the Phase', () => {
    const plan = planOf('claude', ['outside-workspace-write', 'process-spawn', 'network']);
    const sentence = describeCapabilityOutcome(plan, NAME);
    expect(sentence).not.toBeNull();
    expect(sentence?.toLowerCase().startsWith(TOOL_CLASS.toLowerCase())).toBe(true);
    expect(sentence).toContain(`"${NAME}"`);
  });

  it('opens a CLI sandbox with its class', () => {
    const plan = planOf('codex', ['workspace-write', 'outside-workspace-write', 'network']);
    const sentence = describeCapabilityOutcome(plan, NAME);
    expect(sentence?.toLowerCase().startsWith(SANDBOX_CLASS.toLowerCase())).toBe(true);
  });

  describe.each(Object.entries(CLAUSES))('the %s clause', (residual, clause) => {
    it('is one fixed clause, present when the residual is', () => {
      // Find a real cell that carries this residual, so the sentence is built from a real plan.
      let found = false;
      for (const kind of SUPPORTED_BACKENDS) {
        for (let mask = 0; mask < 16; mask += 1) {
          const granted = ALL_PHASE_CAPABILITIES.filter((_c, index) => (mask & (1 << index)) !== 0);
          const plan = planOf(kind, granted);
          if (plan.outcome !== 'argv' || !plan.residuals.includes(residual as never)) continue;
          found = true;
          expect(describeCapabilityOutcome(plan, NAME)).toContain(clause);
        }
      }
      expect(found, `no cell carries ${residual}`).toBe(true);
    });
  });

  it('is conditional wording for the three shell residuals', () => {
    for (const residual of ['shell-network', 'shell-workspace-write', 'shell-outside-workspace-write'] as const) {
      expect(CLAUSES[residual]).toContain("where the backend's own permission settings let it run");
    }
    const plan = planOf('claude', ['process-spawn']);
    const sentence = describeCapabilityOutcome(plan, NAME) ?? '';
    for (const residual of ['shell-network', 'shell-workspace-write', 'shell-outside-workspace-write'] as const) {
      expect(sentence).toContain(CLAUSES[residual]);
    }
  });

  it('keeps the Agy shell-refusal clause conditional on the backend settings (feature 279)', () => {
    expect(CLAUSES['mode-refuses-shell']).toContain("unless the backend's own permission settings allow it");
  });

  it('gives the two Agy accept-edits cells the contract sentences (feature 279, FR-010)', () => {
    const outsideOnly = planOf('agy', ['workspace-write', 'process-spawn', 'network']);
    expect(describeCapabilityOutcome(outsideOnly, NAME)).toBe(
      `A tool-access restriction, not OS isolation applies to phase "${NAME}": ${CLAUSES['mode-refuses-shell']}.`
    );
    const outsideAndShell = planOf('agy', ['workspace-write', 'network']);
    expect(describeCapabilityOutcome(outsideAndShell, NAME)).toBe(
      `A tool-access restriction, not OS isolation applies to phase "${NAME}": ${CLAUSES['sandbox-scope-unqualified']}.`
    );
  });

  it('puts the clauses in residual order, one each', () => {
    const plan = planOf('claude', ['process-spawn']);
    const sentence = describeCapabilityOutcome(plan, NAME) ?? '';
    expect(plan.outcome === 'argv' && plan.residuals).toEqual([
      'shell-network',
      'shell-outside-workspace-write',
      'shell-workspace-write',
      'unlisted-tools'
    ]);
    const positions = (plan.outcome === 'argv' ? plan.residuals : []).map((r) => sentence.indexOf(CLAUSES[r]));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  describe('a refusal', () => {
    it('names its capabilities and does not claim an unconfirmed flag when none is', () => {
      const plan = planOf('agy', ['workspace-write', 'outside-workspace-write', 'process-spawn']);
      const sentence = describeCapabilityOutcome(plan, NAME) ?? '';
      expect(plan.outcome).toBe('refused');
      expect(sentence).toContain('agy');
      expect(sentence).toContain('network');
      expect(sentence).toContain(`"${NAME}"`);
      expect(sentence).not.toMatch(/could not be confirmed/i);
    });

    it('says the flags could not be confirmed only when the unqualified list is not empty', () => {
      const unconfirmed = planCapabilityEnforcement(
        'claude',
        declaredCapabilitySet(['outside-workspace-write', 'process-spawn', 'network']),
        { claude: ['--dangerously-skip-permissions'], codex: ['--sandbox'], agy: ['--sandbox'] }
      );
      expect(unconfirmed.outcome === 'refused' && unconfirmed.unqualified).toEqual(['workspace-write']);
      const sentence = describeCapabilityOutcome(unconfirmed, NAME) ?? '';
      expect(sentence).toMatch(/could not be confirmed/i);
      expect(sentence).toContain('workspace-write');
      // By what: the planner consults no installed CLI at run time, only the capture it shipped with.
      expect(sentence).toContain('help capture');
      expect(sentence).not.toMatch(/against the installed/i);
    });

    it('lists every unenforceable capability', () => {
      const plan = planOf('agy', []);
      const sentence = describeCapabilityOutcome(plan, NAME) ?? '';
      expect(plan.outcome === 'refused' && plan.unenforceable).toEqual(['workspace-write', 'network']);
      for (const capability of ['workspace-write', 'network']) {
        expect(sentence).toContain(capability);
      }
      // Feature 279: `--mode accept-edits` withholds it, so the refusal no longer names it.
      expect(sentence).not.toContain('outside-workspace-write');
    });
  });

  it('only the Phase name varies: the same plan with another name differs in that name alone', () => {
    const plan = planOf('claude', ['outside-workspace-write', 'process-spawn', 'network']);
    const one = describeCapabilityOutcome(plan, 'Alpha') ?? '';
    const two = describeCapabilityOutcome(plan, 'Beta') ?? '';
    expect(one.replace('Alpha', 'Beta')).toBe(two);
  });

  it('uses no phrase the wording gate forbids, in any sentence the module can produce', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (let mask = 0; mask < 16; mask += 1) {
        const granted = ALL_PHASE_CAPABILITIES.filter((_c, index) => (mask & (1 << index)) !== 0);
        const sentence = describeCapabilityOutcome(planOf(kind, granted), NAME);
        if (sentence !== null) expect(sentence, `${kind} ${granted.join(',')}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('never says a tool denial is containment', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (let mask = 0; mask < 16; mask += 1) {
        const granted = ALL_PHASE_CAPABILITIES.filter((_c, index) => (mask & (1 << index)) !== 0);
        const plan = planOf(kind, granted);
        const sentence = describeCapabilityOutcome(plan, NAME);
        if (sentence !== null && plan.outcome === 'argv' && plan.enforcement === 'tool-restriction') {
          expect(sentence.toLowerCase()).not.toMatch(/contain(ed|ment)/);
        }
      }
    }
  });
});
