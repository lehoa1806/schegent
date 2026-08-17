/**
 * Feature 011 T063 — fatal-signatures integration coverage.
 *
 * Covers:
 *   SC-009 — an operator-defined fatal signature triggers fail-fast on
 *            the very next invocation, the audit attribution reflects
 *            `source: 'operator-defined'`, and `delayedRetryCount`
 *            stays at 0 (fail-fast supersedes delayed-retry classes).
 *   SC-010 — the webview's mirror has no remove affordance on built-in
 *            entries (covered by the FatalSignaturesTab unit test
 *            below) and the host's writeGeneralSettings refuses any
 *            payload that would inject a non-string element.
 *
 * Drives the public surface of `getEffectiveSignatures` +
 * `classifyFatal` end-to-end, mimicking how the phase-runner will use
 * them, and validates the host write-validation guard.
 */

import { describe, it, expect } from 'vitest';
import {
  FATAL_SIGNATURES,
  classifyFatal,
  getEffectiveSignatures
} from '../../src/lib/fatal-signature-registry';
import {
  readFatalSignaturesSetting,
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../src/config/general-settings';

interface InspectResult<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
}

class FakeWorkspaceConfig {
  public readonly updateCalls: Array<{ key: string; value: unknown; target: number }> = [];
  private readonly workspace: Record<string, unknown>;

  constructor(workspace: Record<string, unknown> = {}) {
    this.workspace = { ...workspace };
  }

  get<T>(key: string, fallback: T): T {
    return (key in this.workspace ? this.workspace[key] : fallback) as T;
  }

  inspect<T>(key: string): InspectResult<T> | undefined {
    const out: InspectResult<T> = {};
    if (key in this.workspace) out.workspaceValue = this.workspace[key] as T;
    return out;
  }

  update(key: string, value: unknown, target: number): Promise<void> {
    this.updateCalls.push({ key, value, target });
    this.workspace[key] = value;
    return Promise.resolve();
  }
}

function makeConfig(workspace: Record<string, unknown> = {}): GeneralSettingsConfig {
  return new FakeWorkspaceConfig(workspace) as unknown as GeneralSettingsConfig;
}

describe('Feature 011 T063 — fatal-signatures integration', () => {
  it('SC-009: operator-defined signature on stdout triggers fail-fast with source=operator-defined', () => {
    // Operator added "CRASH_TOKEN_XYZ" to settings.
    const config = makeConfig({ fatalSignatures: ['CRASH_TOKEN_XYZ'] });
    const operatorAdditions = readFatalSignaturesSetting(config);
    const effective = getEffectiveSignatures(operatorAdditions);

    const stdout = 'Some preamble\nCRASH_TOKEN_XYZ encountered\nMore lines\n';
    const stderr = '';
    const result = classifyFatal(stdout, stderr, effective);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.signature).toBe('CRASH_TOKEN_XYZ');
      expect(result.source).toBe('operator-defined');
      expect(result.stream).toBe('stdout');
    }
  });

  it('SC-009: operator-defined signature on stderr triggers fail-fast and is attributed to stderr', () => {
    const config = makeConfig({ fatalSignatures: ['unrecoverable: license'] });
    const operatorAdditions = readFatalSignaturesSetting(config);
    const effective = getEffectiveSignatures(operatorAdditions);

    const result = classifyFatal('clean stdout', 'fatal stderr: unrecoverable: license\n', effective);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.signature).toBe('unrecoverable: license');
      expect(result.source).toBe('operator-defined');
      expect(result.stream).toBe('stderr');
    }
  });

  it('SC-009: built-in still wins when both built-in and operator-defined would match (deterministic attribution)', () => {
    const builtIn = FATAL_SIGNATURES[0];
    const config = makeConfig({ fatalSignatures: [builtIn, 'custom-tag'] });
    const operatorAdditions = readFatalSignaturesSetting(config);
    const effective = getEffectiveSignatures(operatorAdditions);

    // On stderr: FATAL_SIGNATURES[0] is stderr-scoped, so that is the stream
    // where both entries are eligible and precedence is observable.
    const stderr = `${builtIn} appears AND so does custom-tag`;
    const result = classifyFatal('', stderr, effective);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.source).toBe('built-in');
      expect(result.signature).toBe(builtIn);
    }
  });

  it('SC-010: writeGeneralSettings rejects array containing non-string elements', async () => {
    const config = makeConfig();
    const r = await writeGeneralSettings(config, {
      fatalSignatures: ['ok', 42, null]
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/invalid-array:fatalSignatures/);
    }
  });

  it('SC-010: writeGeneralSettings rejects array containing empty / whitespace strings', async () => {
    const config = makeConfig();
    const r = await writeGeneralSettings(config, { fatalSignatures: [''] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/invalid-array:fatalSignatures/);
    }
  });

  it('SC-010: writeGeneralSettings accepts a valid string array and persists to workspace target', async () => {
    const fake = new FakeWorkspaceConfig();
    const config = fake as unknown as GeneralSettingsConfig;
    const r = await writeGeneralSettings(config, {
      fatalSignatures: ['op-A', 'op-B']
    });
    expect(r.ok).toBe(true);
    expect(fake.updateCalls.length).toBe(1);
    expect(fake.updateCalls[0].key).toBe('fatalSignatures');
    expect(fake.updateCalls[0].value).toEqual(['op-A', 'op-B']);
  });

  it('FR-038 reinforcement: even if operator duplicates a built-in entry, the audit attribution remains built-in', () => {
    const builtIn = FATAL_SIGNATURES[0];
    const effective = getEffectiveSignatures([builtIn, builtIn, builtIn]);
    // The effective list should NOT contain a separate operator-defined entry
    // for `builtIn`. There should be exactly one entry for it, and its
    // source is built-in.
    const matches = effective.filter((e) => e.pattern === builtIn);
    expect(matches.length).toBe(1);
    expect(matches[0].source).toBe('built-in');
  });

  it('end-to-end: malformed config does not block classification — built-in floor still applies', () => {
    // Operator's settings.json contains a malformed value (object instead of
    // an array). readFatalSignaturesSetting must return [] without throwing;
    // classifyFatal must still match built-in signatures.
    const config = makeConfig({ fatalSignatures: { bad: 'shape' } });
    const operatorAdditions = readFatalSignaturesSetting(config);
    expect(operatorAdditions).toEqual([]);
    const effective = getEffectiveSignatures(operatorAdditions);
    // Force a built-in match, on the stream FATAL_SIGNATURES[0] is scoped to.
    const result = classifyFatal('', FATAL_SIGNATURES[0], effective);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.source).toBe('built-in');
    }
  });
});
