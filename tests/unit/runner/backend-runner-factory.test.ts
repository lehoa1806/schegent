import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBackendRunner,
  resolveBackendKind
} from '../../../src/runner/backend-runner-factory';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import { DEFAULT_BACKEND, SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';

describe('resolveBackendKind', () => {
  it('returns the default when the value is undefined / null / empty', () => {
    expect(resolveBackendKind(undefined)).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind(null)).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind('')).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind('   ')).toBe(DEFAULT_BACKEND);
  });

  it.each(SUPPORTED_BACKENDS)('accepts %s exactly', (kind) => {
    expect(resolveBackendKind(kind)).toBe(kind);
  });

  it('lowercases and trims supported values', () => {
    expect(resolveBackendKind('  CLAUDE  ')).toBe('claude');
    expect(resolveBackendKind('Codex')).toBe('codex');
  });

  it('falls back to the default and warns when the value is unknown', () => {
    const logger = { warn: vi.fn() };
    expect(resolveBackendKind('gemini', logger)).toBe(DEFAULT_BACKEND);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('unknown schegent.backend.runner');
    expect(logger.warn.mock.calls[0][0]).toContain('gemini');
  });

  it('does not warn for valid values', () => {
    const logger = { warn: vi.fn() };
    resolveBackendKind('codex', logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('createBackendRunner', () => {
  it('constructs a ClaudeCliRunner for kind=claude', () => {
    const runner = createBackendRunner('claude', { uncontainedGranted: () => new Set<BackendRunnerKind>(['claude', 'agy']) });
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('constructs a CodexCliRunner for kind=codex', () => {
    const runner = createBackendRunner('codex', { uncontainedGranted: () => new Set<BackendRunnerKind>() });
    expect(runner).toBeInstanceOf(CodexCliRunner);
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('forwards the monitor hook into the concrete runner', () => {
    const hook = vi.fn();
    const claude = createBackendRunner('claude', { uncontainedGranted: () => new Set<BackendRunnerKind>(['claude', 'agy']), monitorHook: hook });
    const codex = createBackendRunner('codex', { uncontainedGranted: () => new Set<BackendRunnerKind>(), monitorHook: hook });
    // The hooks aren't observable from outside, but neither construction
    // should throw — that's the contract.
    expect(claude).toBeInstanceOf(ClaudeCliRunner);
    expect(codex).toBeInstanceOf(CodexCliRunner);
  });
});

/**
 * FR-R3-125 (FR-007, T1019/T1020) — the compounding case, said once.
 *
 * `warnIfEnvironmentIsUnrestricted` in `src/activation/backend-wiring.ts` already
 * warns about `inherit`, once per workspace at activation. It is correct on its own
 * and is deliberately untouched; what it cannot say is which backend is spawning,
 * so the conjunction — no OS bound AND the full ambient environment — was never
 * stated as one fact anywhere.
 *
 * All four combinations are asserted. A warning that fires on three of four is
 * noise, and noise gets filtered, which is how the one that mattered is lost.
 */
describe('createBackendRunner — the uncontained + inherit compound warning', () => {
  const GRANT_ALL = (): ReadonlySet<BackendRunnerKind> => new Set<BackendRunnerKind>(['claude', 'agy']);
  const compound = (calls: readonly string[]): readonly string[] =>
    calls.filter((message) => message.includes("'inherit'"));

  function build(
    kind: BackendRunnerKind,
    environmentMode: 'inherit' | 'allowlist' | 'minimal'
  ): readonly string[] {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    createBackendRunner(kind, {
      uncontainedGranted: GRANT_ALL,
      environmentMode,
      logger: logger as unknown as SanitizedLogger
    });
    return warn.mock.calls.map((call) => String(call[0]));
  }

  it('fires for an uncontained backend with environmentMode=inherit', () => {
    const messages = compound(build('claude', 'inherit'));
    expect(messages).toHaveLength(1);
    // Both facts named, and what it means, so the operator does not have to
    // assemble the consequence from two log lines.
    expect(messages[0]).toContain('no OS-enforced bound');
    expect(messages[0]).toContain('schegent.cli.environmentMode');
    expect(messages[0]).toContain('credentials');
    expect(messages[0]).toContain('untrusted-repositories.md');
  });

  it('is silent for an uncontained backend with a restricted environment', () => {
    expect(compound(build('claude', 'allowlist'))).toEqual([]);
    expect(compound(build('agy', 'minimal'))).toEqual([]);
  });

  it('is silent for a contained backend, whatever the environment mode', () => {
    // Codex is bounded by the OS; `inherit` is a separate concern the
    // activation-time warning already covers, and repeating it here would make
    // this warning fire on a case where the conjunction does not hold.
    expect(compound(build('codex', 'inherit'))).toEqual([]);
    expect(compound(build('codex', 'minimal'))).toEqual([]);
  });

  it('is silent when the environment mode is not supplied', () => {
    // A caller that cannot know the mode must not be forced to guess, and a
    // missing mode suppresses the warning rather than fabricating one.
    const warn = vi.fn();
    createBackendRunner('claude', {
      uncontainedGranted: GRANT_ALL,
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SanitizedLogger
    });
    expect(compound(warn.mock.calls.map((call) => String(call[0])))).toEqual([]);
  });
});

/**
 * FR-R3-125 (FR-008, T020a) — the enforcement point did not move.
 *
 * The setting's shape changed and its signature changed with it. That is exactly
 * the kind of change under which a refusal quietly relocates or acquires a second
 * home, so the three properties `FR-R3-056` relies on are asserted here rather
 * than assumed.
 */
describe('the refusal is still enforced at construction and nowhere else', () => {
  it('refuses at createBackendRunner, the last point before the object exists', () => {
    expect(() =>
      createBackendRunner('claude', { uncontainedGranted: () => new Set<BackendRunnerKind>() })
    ).toThrow(/without an OS-enforced bound/);
  });

  it('keeps the posture option required, so tsc enumerates construction sites', () => {
    // Read from source: the property must not be optional. An optional gate is a
    // gate omitted at the one call site nobody revisits.
    //
    // FR-R3-146 (FR-003) — the declared type is a THUNK now, not a set. A set is a
    // value a caller can resolve once and freeze on an object that outlives the
    // setting; `tests/lint/uncontained-backend-not-hardcoded.test.ts` forbids that
    // shape, and this assertion is what keeps the declaration in step with it.
    const source = readFileSync(
      resolve(__dirname, '../../../src/runner/backend-runner-factory.ts'),
      'utf8'
    );
    expect(source).toMatch(/readonly uncontainedGranted: \(\) => ReadonlySet<BackendRunnerKind>;/);
    expect(source).not.toMatch(/uncontainedGranted\?/);
  });

  it('has exactly one call to the policy judge in production code', () => {
    // A second enforcement site for one rule is the shape this round has removed
    // repeatedly: two sites drift, and the one that drifts permissive is the one
    // that matters.
    const files = ['src/runner/backend-runner-factory.ts', 'src/activation/backend-execution-wiring.ts'];
    const calls = files
      .map((rel) => readFileSync(resolve(__dirname, '../../../', rel), 'utf8'))
      .join('\n')
      .match(/judgeBackendContainment\s*\(/g);
    expect(calls, 'the judge must be called at least once').not.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

/**
 * FR-R3-146 (FR-003, SC-001) — the grant is read at judgement time, not at wiring.
 *
 * This is what makes a mid-session grant take effect without a window reload, and
 * it is the whole reason the option became a thunk. Asserted through the registry
 * as well as the factory, because the registry is the object with the long life:
 * it is built once at activation and lives as long as the window, and the defect
 * this replaces was a set resolved once and frozen onto it.
 */
describe('the grant is re-read per construction, so a mid-session grant takes effect', () => {
  it('refuses, then allows, when the setting changes between calls', () => {
    // Stands in for `schegent.backend.uncontainedBackends` moving from `[]` to
    // `["claude"]` — an operator editing settings, or the consent modal writing.
    const granted = new Set<BackendRunnerKind>();
    const options = { uncontainedGranted: (): ReadonlySet<BackendRunnerKind> => granted };

    expect(() => createBackendRunner('claude', options)).toThrow(/without an OS-enforced bound/);
    granted.add('claude');
    expect(createBackendRunner('claude', options)).toBeInstanceOf(ClaudeCliRunner);
  });

  it('does not require the registry to be rebuilt for the new grant to be seen', () => {
    const granted = new Set<BackendRunnerKind>();
    // The real factory, not the mock: the point is the judgement, not the call.
    const registry = new BackendRunnerRegistry(
      { uncontainedGranted: (): ReadonlySet<BackendRunnerKind> => granted },
      'claude'
    );

    expect(() => registry.getOrCreate('claude')).toThrow(/without an OS-enforced bound/);
    granted.add('claude');
    // Same registry instance, no re-wiring, no reload.
    expect(registry.getOrCreate('claude')).toBeInstanceOf(ClaudeCliRunner);
  });

  it('still states the compounding case when the grant arrived mid-session', () => {
    // FR-R3-146 (FR-014) — a grant written by the consent modal must not become a
    // route that skips FR-R3-125's warning. The construction that SUCCEEDS is the one
    // that warns, and it is reached only after the grant exists, so the warning has
    // to fire on that second call or it never fires for a prompted operator at all.
    const granted = new Set<BackendRunnerKind>();
    const logger = { warn: vi.fn(), info: vi.fn() } as unknown as SanitizedLogger;
    const options = {
      uncontainedGranted: (): ReadonlySet<BackendRunnerKind> => granted,
      environmentMode: 'inherit' as const,
      logger
    };

    expect(() => createBackendRunner('claude', options)).toThrow(/without an OS-enforced bound/);
    // Non-vacuity: nothing was warned while the backend was refused, because nothing ran.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

    granted.add('claude');
    createBackendRunner('claude', options);
    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.join('\n')).toContain('schegent.cli.environmentMode');
    expect(warnings.join('\n')).toContain('full ambient environment');
  });

  it('keeps refusing a kind the grant does not name, however many times it is asked', () => {
    // The converse: a live read must not become "the first answer wins".
    const granted = new Set<BackendRunnerKind>(['agy']);
    const registry = new BackendRunnerRegistry(
      { uncontainedGranted: (): ReadonlySet<BackendRunnerKind> => granted },
      'claude'
    );
    expect(() => registry.getOrCreate('claude')).toThrow(/without an OS-enforced bound/);
    expect(() => registry.getOrCreate('claude')).toThrow(/without an OS-enforced bound/);
  });
});
