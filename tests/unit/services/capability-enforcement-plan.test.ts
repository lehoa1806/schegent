// FR-R3-086 — the enforcement plan, exercised over the whole cross-product.
//
// The plan is pure, so "exhaustive" is affordable: three backends x every subset
// of four capabilities = 48 cases, each decided without a process, a filesystem
// or a clock. That is the difference between a mechanism and a claim about one —
// and the reason a table like this belongs in a unit test rather than in an
// integration run that samples three of them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import {
  ALL_PHASE_CAPABILITIES,
  DEFAULT_CAPABILITY_SET,
  declaredCapabilitySet,
  type PhaseCapability
} from '../../../src/contracts/phase-capabilities';
import {
  enforceableCapabilities,
  planCapabilityEnforcement,
  unboundedArgs
} from '../../../src/services/capability-enforcement-plan';

/** Every subset of the capability union. */
function subsets(): PhaseCapability[][] {
  const out: PhaseCapability[][] = [];
  const n = ALL_PHASE_CAPABILITIES.length;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    out.push(ALL_PHASE_CAPABILITIES.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

/**
 * The argv each adapter spawns with today, as literals.
 *
 * Captured here rather than read from the plan, so this is an independent
 * statement of what "unchanged" means. A test that read the value it is checking
 * would assert nothing — the shape `scanning-gates-prove-they-scanned` was built
 * to catch.
 */
const PRE_CHANGE_ARGV: Readonly<Record<BackendRunnerKind, readonly string[]>> = {
  claude: ['--dangerously-skip-permissions'],
  agy: ['--dangerously-skip-permissions'],
  codex: ['--sandbox', 'workspace-write']
};

describe('FR-R3-086 — the capability enforcement plan', () => {
  it('the default set produces each backend\'s CURRENT argv, byte for byte', () => {
    // FR-072 and SC-019. A phase that declares nothing must spawn exactly as it
    // does today; if this fails, every existing run has changed shape.
    for (const kind of SUPPORTED_BACKENDS) {
      const plan = planCapabilityEnforcement(kind, DEFAULT_CAPABILITY_SET);
      expect(plan.outcome).toBe('argv');
      if (plan.outcome !== 'argv') throw new Error('unreachable');
      expect(plan.args).toEqual(PRE_CHANGE_ARGV[kind]);
      expect(unboundedArgs(kind)).toEqual(PRE_CHANGE_ARGV[kind]);
    }
  });

  it('a set granting everything is the same as the default', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      const all = declaredCapabilitySet([...ALL_PHASE_CAPABILITIES]);
      const plan = planCapabilityEnforcement(kind, all);
      expect(plan.outcome).toBe('argv');
      if (plan.outcome !== 'argv') throw new Error('unreachable');
      expect(plan.args).toEqual(PRE_CHANGE_ARGV[kind]);
    }
  });

  it('decides every backend x every capability subset without throwing', () => {
    let decided = 0;
    for (const kind of SUPPORTED_BACKENDS) {
      for (const subset of subsets()) {
        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(subset));
        expect(['argv', 'refused']).toContain(plan.outcome);
        decided += 1;
      }
    }
    // 3 backends x 2^4 subsets. Stated so an empty cross-product cannot pass.
    expect(decided).toBe(SUPPORTED_BACKENDS.length * 2 ** ALL_PHASE_CAPABILITIES.length);
  });

  it('refuses exactly when a withheld capability has no expression on that backend', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      const expressible = new Set(enforceableCapabilities(kind));
      for (const subset of subsets()) {
        const withheld = ALL_PHASE_CAPABILITIES.filter((capability) => !subset.includes(capability));
        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(subset));
        const shouldRefuse = withheld.some((capability) => !expressible.has(capability));
        expect(plan.outcome === 'refused', `${kind} withholding ${withheld.join(',')}`).toBe(
          shouldRefuse
        );
      }
    }
  });

  it('a refusal names EVERY unenforceable capability, not the first', () => {
    // A refusal naming one of three problems sends someone back twice.
    const plan = planCapabilityEnforcement('agy', declaredCapabilitySet(['process-spawn']));
    expect(plan.outcome).toBe('refused');
    if (plan.outcome !== 'refused') throw new Error('unreachable');
    expect(plan.unenforceable.length).toBeGreaterThan(1);
    expect(new Set(plan.unenforceable).size).toBe(plan.unenforceable.length);
    for (const capability of plan.unenforceable) {
      expect(ALL_PHASE_CAPABILITIES).toContain(capability);
    }
  });

  it('withholding a capability changes the argv — the plan is not a no-op', () => {
    // NON-VACUITY for the whole mechanism. If narrowing produced the unbounded
    // argv, every other assertion here would still pass and nothing would be
    // bounded.
    const narrowed = planCapabilityEnforcement(
      'claude',
      declaredCapabilitySet(['workspace-write', 'outside-workspace-write', 'network'])
    );
    expect(narrowed.outcome).toBe('argv');
    if (narrowed.outcome !== 'argv') throw new Error('unreachable');
    expect(narrowed.args).not.toEqual(PRE_CHANGE_ARGV.claude);
    expect(narrowed.args).toContain('--disallowedTools');
    expect(narrowed.args.join(' ')).toContain('Bash');
    expect(narrowed.args).not.toContain('--dangerously-skip-permissions');
  });

  it('never emits a mode that would prompt — an interactive halt deadlocks the orchestrator', () => {
    // Constitution principle I. Schegent spawns without a TTY, so a prompt is not
    // a slower success, it is a hang until the timeout. A capability that could
    // only be enforced by asking a human is classified unenforceable instead.
    const PROMPTING = ['ask', 'prompt', 'interactive', 'confirm', 'on-request', 'untrusted'];
    for (const kind of SUPPORTED_BACKENDS) {
      for (const subset of subsets()) {
        const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(subset));
        if (plan.outcome !== 'argv') continue;
        const joined = plan.args.join(' ').toLowerCase();
        for (const token of PROMPTING) {
          expect(joined, `${kind}: argv must not request a prompting mode`).not.toContain(token);
        }
      }
    }
  });

  it('emits a deterministic argv — the same set always produces the same flags', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      for (const subset of subsets()) {
        const a = planCapabilityEnforcement(kind, declaredCapabilitySet(subset));
        const b = planCapabilityEnforcement(kind, declaredCapabilitySet([...subset].reverse()));
        expect(a).toEqual(b);
      }
    }
  });

  it('is pure: no filesystem, process or clock reference in the module', () => {
    // Purity is what makes the cross-product above affordable and reproducible.
    // Read with the CJS-friendly `__dirname`, which is what this test program
    // compiles to — `import.meta` is TS1470 here.
    const source = readFileSync(
      resolve(__dirname, '../../../src/services/capability-enforcement-plan.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/require\(|from 'node:fs'|process\.|Date\.now/);
  });
});
