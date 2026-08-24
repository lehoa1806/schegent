import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOW_UNCONTAINED_SETTING,
  containmentByBackend,
  containmentOf,
  judgeBackendContainment
} from '../../../src/services/backend-containment-policy';
import {
  createBackendRunner,
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  UncontainedBackendRefusedError
} from '../../../src/runner/backend-runner-factory';
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
});

describe('the default posture refuses an uncontained backend', () => {
  it('refuses claude and agy when the setting is off', () => {
    for (const kind of ['claude', 'agy'] as const) {
      const verdict = judgeBackendContainment(kind, false);
      expect(verdict.outcome).toBe('refused');
      if (verdict.outcome !== 'refused') return;
      expect(verdict.kind).toBe(kind);
      // A refusal an operator cannot act on is one they work around.
      expect(verdict.message).toContain(ALLOW_UNCONTAINED_SETTING);
      expect(verdict.message).toContain('agent-capability-posture.md');
    }
  });

  it('refuses the SHIPPED DEFAULT backend', () => {
    // The acceptance criterion in one assertion: a fresh install's default run
    // path cannot reach unprompted OS-user capability without the mechanism
    // engaging. `backend.runner` defaults to `claude`.
    expect(judgeBackendContainment(DEFAULT_BACKEND, false).outcome).toBe('refused');
  });

  it('allows codex regardless of the setting', () => {
    // Its sandbox is the bound; the setting is about accepting the absence of one.
    expect(judgeBackendContainment('codex', false).outcome).toBe('allowed');
    expect(judgeBackendContainment('codex', true).outcome).toBe('allowed');
  });

  it('allows an uncontained backend once the setting is on', () => {
    for (const kind of ['claude', 'agy'] as const) {
      const verdict = judgeBackendContainment(kind, true);
      expect(verdict.outcome).toBe('allowed');
      if (verdict.outcome !== 'allowed') return;
      // Still reported as uncontained: enabling it accepts the posture, it does
      // not change what the backend is.
      expect(verdict.containment).toBe('none');
    }
  });
});

describe('the refusal is enforced where a backend is constructed', () => {
  it('throws for an uncontained backend when the host has not accepted the posture', () => {
    // The mechanism, not the policy: this is the call every route reaches --
    // admission, resume, an auto-drain, a continuation. A check at admission
    // alone would be bypassed by every path that does not go through admission,
    // which is most of them.
    expect(() => createBackendRunner('claude', { allowUncontained: false })).toThrow(
      UncontainedBackendRefusedError
    );
    expect(() => createBackendRunner('agy', { allowUncontained: false })).toThrow(
      UncontainedBackendRefusedError
    );
  });

  it('constructs a contained backend with the posture unaccepted', () => {
    expect(() => createBackendRunner('codex', { allowUncontained: false })).not.toThrow();
  });

  it('refuses through the registry too, which is what the host actually holds', () => {
    const registry = new BackendRunnerRegistry({ allowUncontained: false });
    // No argument: the global default, which is `claude`. A fresh install's
    // default run path, refused.
    expect(() => registry.getOrCreate()).toThrow(/without an OS-enforced bound/);
  });

  it('names the setting and the decision record in what it throws', () => {
    try {
      createBackendRunner('claude', { allowUncontained: false });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain(ALLOW_UNCONTAINED_SETTING);
      expect((error as Error).message).toContain('agent-capability-posture.md');
    }
  });
});
