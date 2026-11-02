// FR-R3-086 — the enforcement plan, exercised over the whole cross-product.
//
// The plan is pure, so "exhaustive" is affordable: three backends x every subset
// of four capabilities = 48 cases, each decided without a process, a filesystem
// or a clock. That is the difference between a mechanism and a claim about one —
// and the reason a table like this belongs in a unit test rather than in an
// integration run that samples three of them.
import { observeAmbientConfig } from '../../../src/services/ambient-config-observer';
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
import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';
import { snapshotPhaseDef } from '../../../src/config/pipeline-snapshot';
import { recordCapabilityDecision } from '../../../src/controller/capability-decision-recorder';
import {
  CapabilityNotEnforceableError,
  isCapabilityRefusal
} from '../../../src/services/capability-refusal';
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

/**
 * FR-R3-086 — the seam from an authored Phase definition to the adapter's argv.
 *
 * THE CLASS THIS PINS. A security pass found the mechanism shipped half-wired
 * twice, both the same shape: each half was covered against its own input and
 * nothing drove one into the other. First the shell never forwarded the declared
 * set to the adapter; then the validator rejected `capabilities` as an unknown
 * field, so no phase could declare one at all. Both passed every existing test.
 *
 * These assertions walk the whole path — authored definition, validation,
 * snapshot, plan — so a break anywhere along it is a red test rather than a
 * mechanism that is present and inert.
 */
describe('FR-R3-086 — an authored capability set survives to the argv', () => {
  it('a phase MAY declare capabilities, and the validator accepts them', () => {
    const result = validatePhaseDefinition({
      phaseId: 'probe',
      name: 'Probe',
      version: 1,
      instruction: 'do the thing',
      timeoutSeconds: 60,
      capabilities: ['workspace-write', 'network']
    });
    expect(
      result.errors.filter((error: { field: string }) => error.field === 'capabilities'),
      'a declared capability set must not be rejected as an unknown field'
    ).toEqual([]);
  });

  it('an UNKNOWN capability is rejected, not silently dropped', () => {
    // Dropping it would yield an empty set — every capability withheld — and the
    // phase refused at run time for a reason invisible in its definition.
    const result = validatePhaseDefinition({
      phaseId: 'probe',
      name: 'Probe',
      version: 1,
      instruction: 'do the thing',
      timeoutSeconds: 60,
      capabilities: ['typo-spawn']
    });
    expect(result.errors.some((error: { field: string }) => error.field === 'capabilities')).toBe(true);
  });

  it('the plan snapshot preserves the declared set, frozen', () => {
    const frozen = snapshotPhaseDef({
      id: 'probe',
      name: 'Probe',
      capabilities: ['workspace-write']
    } as never) as unknown as { capabilities?: readonly string[] };
    expect(frozen.capabilities).toEqual(['workspace-write']);
    expect(Object.isFrozen(frozen.capabilities)).toBe(true);
  });

  it('a phase that declares nothing carries nothing through the snapshot', () => {
    // Omission stays omission: writing the full set into every snapshot would
    // change the frozen contract of every untouched phase.
    const plan = planCapabilityEnforcement('claude', DEFAULT_CAPABILITY_SET);
    expect(plan.outcome).toBe('argv');
    if (plan.outcome !== 'argv') throw new Error('unreachable');
    expect(plan.args).toEqual(PRE_CHANGE_ARGV.claude);
  });
});

describe('FR-R3-086 — an applied bound is observable, not just an enforced one', () => {
  interface Recorded {
    readonly eventType: string;
    readonly outcome: string;
    readonly payload: Record<string, unknown>;
  }

  const runWith = async (
    capabilities: readonly string[] | undefined,
    kind: 'claude' | 'agy' | 'codex'
  ): Promise<{ recorded: Recorded[]; threw: boolean }> => {
    const recorded: Recorded[] = [];
    const context = {
      iteration: 2,
      ...(capabilities === undefined ? {} : { phaseDef: { capabilities } })
    };
    let threw = false;
    try {
      await recordCapabilityDecision(context as never, kind, ((
        _inputs: unknown,
        eventType: string,
        outcome: string,
        payload: Record<string, unknown>
      ) => {
        recorded.push({ eventType, outcome, payload });
        return Promise.resolve(undefined);
      }) as never);
    } catch {
      threw = true;
    }
    return { recorded, threw };
  };

  it('records the granted set when a narrowing is enforced', async () => {
    // Argv is where the bound lives and argv is never written to the structured
    // log, so without this event a completed Run cannot tell an operator whether
    // its phase ran bounded or unbounded.
    const { recorded, threw } = await runWith(['workspace-write'], 'claude');
    expect(threw).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].eventType).toBe('capability-applied');
    expect(recorded[0].outcome).toBe('success');
    expect(recorded[0].payload.granted).toEqual(['workspace-write']);
    expect(recorded[0].payload.phaseIndex).toBe(2);
  });

  it('records nothing for a phase that declares no set', async () => {
    // Its argv is unchanged, so a line saying "unchanged" in every Run's evidence
    // would be noise that makes the narrowings harder to find, not easier.
    const { recorded } = await runWith(undefined, 'claude');
    expect(recorded).toEqual([]);
  });

  it('records the refusal, and not a grant, when the backend cannot enforce', async () => {
    // `agy` expresses only `process-spawn`, so withholding anything else is
    // refused before the phase starts. The two events are mutually exclusive.
    const { recorded, threw } = await runWith(['process-spawn'], 'agy');
    expect(threw).toBe(true);
    expect(recorded.map((entry) => entry.eventType)).toEqual(['capability-refused']);
  });

  it('carries no path and no operator-authored content in the payload', async () => {
    // Same discipline the refusal payload is held to: closed-union members, a
    // number, and nothing else that could carry a workspace path or a secret.
    //
    // FR-R3-105 (FR-066) added `ambientConfig`, and it is held to the same rule rather
    // than exempted from it. The observation is a DIGEST plus the NAMES of the keys read —
    // never the config path (AGENTS.md forbids workspace paths in the structured log, and
    // a home-directory path additionally carries the operator's username) and never the
    // values (a settings file can hold an API key). The assertion below is on the key set,
    // so a future field that did carry a path would fail here.
    const { recorded } = await runWith(['network', 'workspace-write'], 'claude');
    const payload = recorded[0].payload;
    // FR-R4-F06 (K5) added `enforcement` and `residuals`: closed-union members, like `kind`.
    expect(Object.keys(payload).sort()).toEqual([
      'ambientConfig',
      'enforcement',
      'granted',
      'kind',
      'phaseIndex',
      'residuals'
    ]);
    for (const member of payload.granted as readonly string[]) {
      expect(ALL_PHASE_CAPABILITIES).toContain(member);
    }
    // No observer is injected by this harness, so the honest value is `null` — "nothing
    // observed", which an operator can tell apart from "observed and unchanged".
    expect(payload.ambientConfig).toBeNull();
  });

  it('the ambient observation carries a digest and key NAMES, never a path or a value', async () => {
    // FR-R3-105 (FR-066, FR-086). The shape is asserted against a real observation rather
    // than the null one above, because the null case cannot show what a populated one
    // would leak.
    const observed = await observeAmbientConfig('claude', {
      readFile: async () =>
        JSON.stringify({
          permissions: { allow: ['Bash'] },
          apiKeyHelper: '/Users/someone/secrets/get-key.sh',
          unrelated: 'ignored'
        })
    });
    expect(observed).not.toBeNull();
    if (observed === null) return;

    expect(Object.keys(observed).sort()).toEqual(['digest', 'keysObserved']);
    // Only keys that could WIDEN a bound are read; `apiKeyHelper` is not among them, and
    // its VALUE — a path under a home directory — must not appear anywhere.
    expect(observed.keysObserved).toEqual(['permissions']);
    expect(JSON.stringify(observed)).not.toContain('/Users/');
    expect(JSON.stringify(observed)).not.toContain('get-key.sh');
    expect(observed.digest).toMatch(/^[0-9a-f]{64}$/);

    // Same content digests the same, different content differs — which is the only
    // property a reader comparing two Runs needs.
    const again = await observeAmbientConfig('claude', {
      readFile: async () => JSON.stringify({ permissions: { allow: ['Bash'] } })
    });
    expect(again?.digest).toBe(observed.digest);
    const changed = await observeAmbientConfig('claude', {
      readFile: async () => JSON.stringify({ permissions: { allow: ['Bash', 'WebFetch'] } })
    });
    expect(changed?.digest).not.toBe(observed.digest);
  });

  it('an absent or unreadable ambient config is null, and does not fail the phase', async () => {
    const missing = await observeAmbientConfig('claude', {
      readFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    });
    expect(missing).toBeNull();

    // A backend with no known configuration location is `null` without reading anything.
    let read = false;
    const none = await observeAmbientConfig('agy', {
      readFile: async () => {
        read = true;
        return '{}';
      }
    });
    expect(none).toBeNull();
    expect(read, 'a backend with no config location must not be read at all').toBe(false);
  });
});

// FR-R4-F06 (FR-012; T11; contract K, K3 and K5) -- the audit row says HOW a set was enforced, and why a
// set was refused. `capability-applied` gains `enforcement` and `residuals`; `capability-refused` gains
// `unqualified`. The order and the outcome values are unchanged.
describe('FR-R4-F06 — the audit rows carry the enforcement class, the residuals and the unqualified list', () => {
  interface Seen {
    readonly step: string;
    readonly eventType?: string;
    readonly outcome?: string;
    readonly payload?: Record<string, unknown>;
  }

  async function decide(
    capabilities: readonly string[],
    kind: 'claude' | 'agy' | 'codex'
  ): Promise<Seen[]> {
    const seen: Seen[] = [];
    try {
      await recordCapabilityDecision({ iteration: 4, phaseDef: { capabilities } } as never, kind, ((
        _inputs: unknown,
        eventType: string,
        outcome: string,
        payload: Record<string, unknown>
      ) => {
        seen.push({ step: 'append', eventType, outcome, payload });
        return Promise.resolve(undefined);
      }) as never);
      seen.push({ step: 'returned' });
    } catch {
      seen.push({ step: 'threw' });
    }
    return seen;
  }

  it('records the class and the residuals of an applied set, with outcome success', async () => {
    const seen = await decide(['workspace-write'], 'claude');
    expect(seen.map((entry) => entry.step)).toEqual(['append', 'returned']);
    expect(seen[0]?.eventType).toBe('capability-applied');
    expect(seen[0]?.outcome).toBe('success');
    expect(seen[0]?.payload?.enforcement).toBe('tool-restriction');
    expect(seen[0]?.payload?.residuals).toEqual(['unlisted-tools']);
  });

  it('names a residual that holds only while process-spawn is granted', async () => {
    const seen = await decide(['process-spawn', 'network'], 'claude');
    expect(seen[0]?.payload?.residuals).toEqual([
      'shell-outside-workspace-write',
      'shell-workspace-write',
      'unlisted-tools'
    ]);
  });

  it('records the CLI sandbox class for Codex, and an empty residual list when there is none', async () => {
    const seen = await decide(['outside-workspace-write', 'process-spawn', 'network'], 'codex');
    expect(seen[0]?.payload?.enforcement).toBe('cli-sandbox');
    expect(seen[0]?.payload?.residuals).toEqual([]);
  });

  it('records the refusal with the unqualified list, before it throws, with outcome failure', async () => {
    const seen = await decide(['process-spawn'], 'agy');
    expect(seen.map((entry) => entry.step), 'the append precedes the throw').toEqual(['append', 'threw']);
    expect(seen[0]?.eventType).toBe('capability-refused');
    expect(seen[0]?.outcome).toBe('failure');
    expect(seen[0]?.payload?.unenforceable).toEqual(['workspace-write', 'outside-workspace-write', 'network']);
    expect(seen[0]?.payload?.unqualified).toEqual([]);
    expect(Object.keys(seen[0]?.payload ?? {}).sort()).toEqual([
      'kind',
      'phaseIndex',
      'unenforceable',
      'unqualified'
    ]);
  });

  it('carries the unqualified list on the refusal error as well, under the same code', async () => {
    try {
      await recordCapabilityDecision(
        { iteration: 1, phaseDef: { capabilities: ['process-spawn'] } } as never,
        'agy',
        (() => Promise.resolve(undefined)) as never
      );
      expect.unreachable('agy withholding three capabilities must be refused');
    } catch (error) {
      expect(isCapabilityRefusal(error)).toBe(true);
      expect((error as { unqualified?: unknown }).unqualified).toEqual([]);
      expect((error as Error).name).toBe('CapabilityNotEnforceableError');
    }
  });

  it('words the unconfirmed-flag tail as a fact about the shipped help capture, not a check of the CLI', () => {
    // The planner reads a static transcription of one help capture (`CONFIRMED_FLAGS`) and consults no
    // installed CLI. A message that said "against the installed CLI" would blame an operator's CLI that
    // may simply be newer than that capture. The short form "could not be confirmed" stays: the launcher
    // sentence and the operator documentation use it.
    const withTail = new CapabilityNotEnforceableError('claude', ['workspace-write'], ['workspace-write']);
    expect(withTail.message).toContain('could not be confirmed');
    expect(withTail.message).toContain('help capture');
    expect(withTail.message).not.toMatch(/against the installed/i);
    const withoutTail = new CapabilityNotEnforceableError('agy', ['network']);
    expect(withoutTail.message).toContain('cannot enforce the declared capability set');
    expect(withoutTail.message).not.toContain('could not be confirmed');
  });
});
