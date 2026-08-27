import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOW_UNCONTAINED_SETTING,
  REMOVED_ALLOW_UNCONTAINED_SETTING,
  containmentByBackend,
  containmentOf,
  mechanismByBackend,
  mechanismOf,
  resolveUncontainedGrant,
  judgeBackendContainment
} from '../../../src/services/backend-containment-policy';
import {
  createBackendRunner,
  UncontainedBackendRefusedError
} from '../../../src/runner/backend-runner-factory';
import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../../../src/contracts/backend-kinds';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';

/**
 * FR-R3-056 (H-01) — the mechanism, asserted by test rather than by manifest
 * prose. That phrasing is the item's, and it is the difference between this and
 * the disclosure FR-R3-031/032 shipped.
 */
const ROOT = resolve(__dirname, '..', '..', '..');

/** Each adapter's argv, read from source. The classification's oracle. */
const ADAPTER_SOURCE: Readonly<Record<string, string>> = {
  claude: 'src/runner/claude-cli.ts',
  codex: 'src/runner/codex-cli.ts',
  agy: 'src/runner/agy-cli.ts'
};

const argvOf = (kind: string): string =>
  readFileSync(resolve(ROOT, ADAPTER_SOURCE[kind]!), 'utf8');

describe('the containment classification matches the actual argv', () => {
  it('classifies every supported backend', () => {
    // Enumerate, never sample. A fourth backend arriving unclassified is the
    // failure mode this replaces.
    expect([...containmentByBackend().keys()].sort()).toEqual([...SUPPORTED_BACKENDS].sort());
  });

  it('calls a backend uncontained exactly when its argv skips permissions', () => {
    // The policy must not be a hand-kept restatement of a fact the adapters
    // already carry -- that is the drift FR-R3-051 spent a cycle removing. This
    // reads the argv and compares.
    for (const kind of SUPPORTED_BACKENDS) {
      const source = argvOf(kind);
      const skipsPermissions = source.includes('--dangerously-skip-permissions');
      const hasSandbox = source.includes('--sandbox');
      expect(
        containmentOf(kind),
        `${kind}: argv skipsPermissions=${skipsPermissions} hasSandbox=${hasSandbox}`
      ).toBe(skipsPermissions && !hasSandbox ? 'none' : 'os-enforced');
    }
  });

  it('will not let a bare --sandbox flag reclassify a backend on its own', () => {
    // FR-R3-125. The oracle above reads "argv contains --sandbox" as
    // OS-enforced, which is true for `codex --sandbox workspace-write` and is NOT
    // a general rule: `agy 1.1.22` also has a `--sandbox` flag whose enforcement
    // is unverified (docs/architecture/backend-containment-qualification.md §4).
    // If someone adds that flag to the Agy adapter, the oracle alone would flip
    // agy to 'os-enforced' silently. So the mechanism table is the authority and
    // each contained backend must name a mechanism that is not merely `--sandbox`.
    for (const [kind, mechanism] of mechanismByBackend()) {
      if (containmentOf(kind) === 'none') {
        expect(mechanism, `${kind} is uncontained, so its mechanism must be none`).toBe('none');
        continue;
      }
      expect(
        mechanism,
        `${kind} is classified contained, so the table must name WHICH boundary — a bare ` +
          '--sandbox flag is not a mechanism, and the qualification record must carry the ' +
          'evidence for whatever is named here'
      ).not.toBe('none');
    }
  });
});

/** FR-R3-125 — the grant, spelled the way the setting spells it. */
const grant = (...kinds: readonly BackendRunnerKind[]): ReadonlySet<BackendRunnerKind> =>
  new Set<BackendRunnerKind>(kinds);
const NO_GRANT: ReadonlySet<BackendRunnerKind> = grant();

describe('the default posture refuses an uncontained backend', () => {
  it('refuses claude and agy when nothing is granted', () => {
    for (const kind of ['claude', 'agy'] as const) {
      const verdict = judgeBackendContainment(kind, NO_GRANT);
      expect(verdict.outcome).toBe('refused');
      if (verdict.outcome !== 'refused') return;
      expect(verdict.kind).toBe(kind);
      // A refusal an operator cannot act on is one they work around.
      expect(verdict.message).toContain(ALLOW_UNCONTAINED_SETTING);
      expect(verdict.message).toContain('agent-capability-posture.md');
      // FR-R3-125 (FR-005) — the four things a refused operator needs: the id to
      // add, the scope of the grant, and what happened to the key they may
      // already have set.
      expect(verdict.message).toContain(`'${kind}'`);
      expect(verdict.message).toContain('application-scoped');
      expect(verdict.message).toContain(REMOVED_ALLOW_UNCONTAINED_SETTING);
    }
  });

  it('refuses the SHIPPED DEFAULT backend', () => {
    // The acceptance criterion in one assertion: a fresh install's default run
    // path cannot reach unprompted OS-user capability without the mechanism
    // engaging. `backend.runner` defaults to `claude`.
    expect(judgeBackendContainment(DEFAULT_BACKEND, NO_GRANT).outcome).toBe('refused');
  });

  it('allows codex under every grant — FR-009, asserted not assumed', () => {
    // Codex is contained, so the setting is about accepting the absence of a bound
    // and has nothing to say about it. Asserted across every grant because
    // FR-R3-125 changed this function's signature, and a signature change is
    // exactly how a contained backend acquires a dependency on a safety setting.
    for (const g of [NO_GRANT, grant('claude'), grant('agy'), grant('claude', 'agy')]) {
      const verdict = judgeBackendContainment('codex', g);
      expect(verdict.outcome, `grant=[${[...g].join(',')}]`).toBe('allowed');
      if (verdict.outcome !== 'allowed') return;
      expect(verdict.containment).toBe('os-enforced');
    }
  });

  it('grants one backend WITHOUT granting the other — the whole point of FR-R3-125', () => {
    // The item's title. Before this, one boolean granted full local authority to
    // every uncontained backend at once.
    expect(judgeBackendContainment('agy', grant('agy')).outcome).toBe('allowed');
    expect(judgeBackendContainment('claude', grant('agy')).outcome).toBe('refused');
    expect(judgeBackendContainment('claude', grant('claude')).outcome).toBe('allowed');
    expect(judgeBackendContainment('agy', grant('claude')).outcome).toBe('refused');
  });

  it('is exhaustive over every backend x granted/not-granted', () => {
    // Enumerated rather than sampled: a fourth backend must not be able to appear
    // with no posture assertion covering it.
    for (const kind of SUPPORTED_BACKENDS) {
      const contained = containmentOf(kind) === 'os-enforced';
      expect(judgeBackendContainment(kind, grant(kind)).outcome, `${kind} granted`).toBe('allowed');
      expect(judgeBackendContainment(kind, NO_GRANT).outcome, `${kind} not granted`).toBe(
        contained ? 'allowed' : 'refused'
      );
    }
    expect(SUPPORTED_BACKENDS.length, 'the sweep must have backends to sweep').toBeGreaterThan(2);
  });

  it('still reports a granted backend as uncontained', () => {
    for (const kind of ['claude', 'agy'] as const) {
      const verdict = judgeBackendContainment(kind, grant(kind));
      expect(verdict.outcome).toBe('allowed');
      if (verdict.outcome !== 'allowed') return;
      // Granting accepts the posture; it does not change what the backend is.
      expect(verdict.containment).toBe('none');
      expect(mechanismOf(kind)).toBe('none');
    }
  });
});

describe('the setting is validated, not filtered (FR-004a)', () => {
  it('grants exactly the uncontained backends named', () => {
    const { granted, problems } = resolveUncontainedGrant(['agy']);
    expect([...granted]).toEqual(['agy']);
    expect(problems).toEqual([]);
  });

  it('reports a typo as a typo, naming the ids that exist', () => {
    const { granted, problems } = resolveUncontainedGrant(['claud']);
    expect([...granted]).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe('unsupported');
    // The operator is looking for a spelling mistake, so give them the spellings.
    for (const kind of SUPPORTED_BACKENDS) expect(problems[0]!.message).toContain(kind);
  });

  it('reports an already-contained id as a no-op, not as a typo', () => {
    // Two different problems needing two different sentences: `codex` is a real
    // backend id that was never refused, so telling this operator "unsupported
    // id" sends them hunting a mistake they did not make.
    const { granted, problems } = resolveUncontainedGrant(['codex']);
    expect([...granted]).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe('already-contained');
    expect(problems[0]!.message).toContain('grants nothing');
  });

  it('fails closed on every shape that is not a list of strings', () => {
    // A stale `true` from the removed boolean is the case that matters: it must
    // grant nothing rather than everything.
    for (const raw of [true, false, 'claude', 42, null, undefined, {}]) {
      const { granted } = resolveUncontainedGrant(raw);
      expect([...granted], `raw=${String(raw)}`).toEqual([]);
    }
    const mixed = resolveUncontainedGrant([true, 'agy', 'nope']);
    expect([...mixed.granted]).toEqual(['agy']);
    expect(mixed.problems).toHaveLength(2);
  });

  it('bounds what an operator-controlled entry can put into a log line', () => {
    // The rejected entry is echoed back so the operator can see which one it was,
    // and the value comes from settings — so it is as long as someone made it. An
    // unbounded echo turns a malformed setting into an unbounded log write; the
    // same bound `MAX_REPORTED_PATHS` applies in `run-checkpoint-service.ts`.
    const long = 'x'.repeat(5000);
    const { granted, problems } = resolveUncontainedGrant([long]);
    expect([...granted]).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message.length).toBeLessThan(400);
    // Truncation is marked, so a reader can tell a long value from a short one.
    expect(problems[0]!.message).toContain('5000 chars');
  });

  it('bounds how many entries it reports, without narrowing what it grants', () => {
    // Reporting stops; validation does not. Truncating the report can never widen
    // the grant, which is the property that makes the bound safe.
    const many = Array.from({ length: 200 }, (_, index) => `bogus-${index}`);
    const { granted, problems } = resolveUncontainedGrant([...many, 'agy']);
    expect(problems.length).toBeLessThanOrEqual(10);
    expect([...granted], 'a valid entry after the report bound must still grant').toEqual(['agy']);
  });

  it('never throws, whatever it is given', () => {
    // A malformed safety setting must fail closed and leave the product usable.
    // An exception here takes down activation, and an operator whose extension
    // will not start does not read the reason.
    for (const raw of [true, ['x'], [null], Symbol('s'), () => {}, new Map()]) {
      expect(() => resolveUncontainedGrant(raw)).not.toThrow();
    }
  });
});

describe('the refusal is enforced where a backend is constructed', () => {
  it('throws for an uncontained backend when the host has not accepted the posture', () => {
    // The mechanism, not the policy: this is the call every route reaches --
    // admission, resume, an auto-drain, a continuation. A check at admission
    // alone would be bypassed by every path that does not go through admission,
    // which is most of them.
    expect(() => createBackendRunner('claude', { uncontainedGranted: new Set<BackendRunnerKind>() })).toThrow(
      UncontainedBackendRefusedError
    );
    expect(() => createBackendRunner('agy', { uncontainedGranted: new Set<BackendRunnerKind>() })).toThrow(
      UncontainedBackendRefusedError
    );
  });

  it('constructs a contained backend with the posture unaccepted', () => {
    expect(() => createBackendRunner('codex', { uncontainedGranted: new Set<BackendRunnerKind>() })).not.toThrow();
  });

  it('refuses through the registry too, which is what the host actually holds', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>() });
    // No argument: the global default, which is `claude`. A fresh install's
    // default run path, refused.
    expect(() => registry.getOrCreate()).toThrow(/without an OS-enforced bound/);
  });

  it('names the setting and the decision record in what it throws', () => {
    try {
      createBackendRunner('claude', { uncontainedGranted: new Set<BackendRunnerKind>() });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain(ALLOW_UNCONTAINED_SETTING);
      expect((error as Error).message).toContain('agent-capability-posture.md');
    }
  });
});

/**
 * FR-R3-086 §4 / SC-019 — the default posture is unchanged for anyone who does
 * not opt in.
 *
 * The capability mechanism narrows what an agent may do AFTER it is allowed to
 * start. It must not touch whether it is allowed to start, and it must not change
 * what a phase that declares nothing spawns with. Both are asserted here rather
 * than assumed, because "we did not mean to change that" is not evidence.
 */
describe('FR-R3-086 — the refusal default survives the capability mechanism', () => {
  it('a fresh install still refuses its first uncontained run', () => {
    // Uses the static import at the top of this file rather than a dynamic one:
    // a relative dynamic specifier needs an explicit extension under node16
    // resolution, and there is no reason to reach for one here.
    const judge = judgeBackendContainment;
    // No opt-in: the setting is off, which is what a fresh install has.
    for (const kind of ['claude', 'agy'] as const) {
      const verdict = judge(kind, NO_GRANT);
      expect(verdict.outcome).toBe('refused');
      if (verdict.outcome !== 'refused') throw new Error('unreachable');
      expect(verdict.reason).toBe('uncontained-backend-not-enabled');
    }
    // ...and the contained one is still allowed, so the refusal is targeted
    // rather than blanket.
    expect(judge('codex', NO_GRANT).outcome).toBe('allowed');
  });

  it('the capability mechanism adds no second refusal site for the posture', () => {
    // FR-R3-056's refusal is enforced at ONE site. A capability check that also
    // refused on posture grounds would be a second enforcement point for one
    // rule — the shape the round has removed repeatedly.
    const plan = readFileSync(
      resolve(__dirname, '../../../src/services/capability-enforcement-plan.ts'),
      'utf8'
    );
    expect(plan).not.toContain('allowUncontainedBackends');
    expect(plan).not.toContain('uncontainedBackends');
    expect(plan).not.toContain('uncontained-backend-not-enabled');
  });
});
