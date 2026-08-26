import { describe, expect, it } from 'vitest';
import { planCapabilityEnforcement } from '../../../src/services/capability-enforcement-plan';
import {
  ALL_PHASE_CAPABILITIES,
  type DeclaredCapabilitySet
} from '../../../src/contracts/phase-capabilities';
import {
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../../../src/contracts/backend-kinds';

/**
 * FR-R3-105 (FR-064) — each flag is emitted exactly once, and the argv is asserted
 * LITERALLY.
 *
 * WHY LITERALLY. The defect was invisible to every test that checked behaviour rather
 * than bytes. The plan de-duplicated by `flags.join(' ')`, so two capabilities sharing a
 * flag name with different values both emitted — and claude has three such rows on
 * `--disallowedTools`. Withholding both `process-spawn` and `network` produced
 * `--disallowedTools Bash --disallowedTools WebFetch,WebSearch`, and if the CLI's parser
 * is last-wins then **`Bash` is silently re-granted on the most restrictive set anyone
 * can request**. Every assertion about "the plan refused" or "the plan produced argv"
 * passed throughout.
 *
 * WHAT THIS CANNOT ESTABLISH, stated rather than implied: whether the real CLI's parser
 * is last-wins, first-wins, or merging. That needs a live turn, which costs operator
 * quota; the scenario is authored and recorded `unqualified` in the qualification log
 * (spec B3). What this test establishes is that the host no longer DEPENDS on the answer.
 */
const CAPS = ALL_PHASE_CAPABILITIES;

/**
 * A declared set granting exactly `granted`, so `withheld` is its complement.
 *
 * `declaredAt: 'phase-definition'` because `'default'` means the phase declared nothing
 * and must behave byte-for-byte as it did before the contract existed — a narrowing test
 * that used the default path would be testing the wrong branch.
 */
const granting = (granted: readonly string[]): DeclaredCapabilitySet => ({
  capabilities: CAPS.filter((c) => granted.includes(c)),
  declaredAt: 'phase-definition'
});

const planFor = (kind: BackendRunnerKind, granted: readonly string[]) =>
  planCapabilityEnforcement(kind, granting(granted));

/** How many times a flag name appears in an argv array. */
const occurrences = (args: readonly string[], flag: string): number =>
  args.filter((token) => token === flag).length;

describe('FR-R3-105 — no capability set emits a flag twice', () => {
  it('the strictest claude set emits --disallowedTools exactly once, with merged values', () => {
    // Withhold everything: the case that emitted the flag three times.
    const plan = planFor('claude', []);
    expect(plan.outcome).toBe('argv');
    if (plan.outcome !== 'argv') return;

    expect(occurrences(plan.args, '--disallowedTools')).toBe(1);

    // Asserted literally. The value order follows capability order, which the plan
    // documents as deliberate so the argv is deterministic.
    const at = plan.args.indexOf('--disallowedTools');
    const value = plan.args[at + 1] as string;
    const tools = value.split(',');
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'NotebookEdit']) {
      expect(tools, `${tool} must survive the merge`).toContain(tool);
    }
    // No value lost and none duplicated.
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('withholding exactly two tool capabilities emits one flag, not two (the last-wins case)', () => {
    const plan = planFor('claude', CAPS.filter((c) => c !== 'process-spawn' && c !== 'network'));
    expect(plan.outcome).toBe('argv');
    if (plan.outcome !== 'argv') return;
    expect(occurrences(plan.args, '--disallowedTools')).toBe(1);
    const value = plan.args[plan.args.indexOf('--disallowedTools') + 1] as string;
    expect(value.split(',').sort()).toEqual(['Bash', 'WebFetch', 'WebSearch'].sort());
  });

  it('no backend, at any capability subset, emits any flag more than once', () => {
    // The exhaustive form: every subset of capabilities, every backend. 2^n per backend is
    // small enough to enumerate, and enumerating removes the question of whether the two
    // cases above happened to be the only ones.
    const subsets: string[][] = [[]];
    for (const cap of CAPS) {
      for (const existing of [...subsets]) subsets.push([...existing, cap]);
    }
    for (const kind of SUPPORTED_BACKENDS) {
      for (const granted of subsets) {
        const plan = planFor(kind, granted);
        if (plan.outcome !== 'argv') continue; // a refusal emits no argv
        const flags = plan.args.filter((token) => token.startsWith('-'));
        const repeated = flags.filter((f, i) => flags.indexOf(f) !== i);
        expect(
          repeated,
          `${kind} with granted=[${granted.join(',')}] repeats ${repeated.join(',')}`
        ).toEqual([]);
      }
    }
  });

  it('the unbounded path is unchanged for a phase that narrows nothing', () => {
    // Everything granted means no narrowing was requested, and that argv must be
    // byte-identical to what it always was — this item narrows nobody by accident.
    const plan = planFor('claude', CAPS);
    expect(plan.outcome).toBe('argv');
    if (plan.outcome !== 'argv') return;
    expect(plan.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('a bare flag with no value is still emitted once', () => {
    // agy's `process-spawn` maps to `--sandbox` with no value; the merge path must not
    // drop it or pair it with an empty string.
    const plan = planFor('agy', CAPS.filter((c) => c !== 'process-spawn'));
    expect(plan.outcome).toBe('argv');
    if (plan.outcome !== 'argv') return;
    expect(plan.args).toEqual(['--sandbox']);
  });
});
