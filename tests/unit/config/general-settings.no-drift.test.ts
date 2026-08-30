// FR-R3-143 (T051) — the six new `KEY_SPECS` entries must be *additions*, not
// edits. Every other test in this feature asks whether the new keys work; this
// one asks the opposite question, which nothing else does: did adding them move
// any of the 22 that were already there?
//
// The risk is specific rather than theoretical. `readGeneralSettings` is one
// loop over `Object.keys(KEY_SPECS)` with a shared chain of per-`type`
// validators. Two of the six new keys reuse a type that existed
// (`number-int-range`, `string-enum`), one introduced `array-of-string`'s
// element filter, and all six landed in the same object literal the other 22 sit
// in. A stray edit to a shared validator, a mistyped `typedField`, or a
// `defaultValue` nudged while adding a neighbour would move a projection that no
// assertion in this feature is watching — the webview would simply start showing
// a different number, with the tab's own tests all green because they assert the
// new fields.
//
// HOW THE GOLDENS WERE MADE, AND HOW TO REMAKE THEM. Both records below are the
// literal output of `readGeneralSettings` **as it stood before this feature**,
// at `90cee2aa031a411e1fbc3876236a001e66f0dc2a` (the P0 base commit). They were
// captured by extracting that revision of the module and running it against the
// two stubs in this file:
//
//   git show 90cee2aa:src/config/general-settings.ts > src/config/__head_tmp.ts
//   # import readGeneralSettings from __head_tmp, JSON.stringify both projections
//
// They are NOT transcribed from today's `KEY_SPECS`, which would make this file
// a mirror of the thing it is checking. If a golden ever needs to change, that
// is the finding — it means a pre-existing key's projection moved, and the
// question is why, not how to update the number.
import { describe, expect, it } from 'vitest';
import {
  readGeneralSettings,
  KEY_SPECS,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';

/** The typed fields that existed before FR-R3-143, and their scope entries. */
const BASE_FIELDS = [
  'cliPath',
  'codexPath',
  'agyPath',
  'loggingVerbose',
  'loopMaxIterations',
  'invocationIdleTimeoutSeconds',
  'invocationMaxDurationSeconds',
  'watchdogPollIntervalMinutes',
  'auditRotationSizeMB',
  'auditRotationMaxAgeDays',
  'defaultPipelineId',
  'fatalSignatures',
  'claudeAutoCompactPctOverride',
  'runtimeLogLevel',
  'runtimeLogFilePath',
  'retryMaxAttempts',
  'retryForceContinueOnCap',
  'runtimeLogMaxBytes',
  'runtimeLogMaxGenerations',
  'sessionRetentionMaxAgeDays',
  'sessionRetentionMaxBytes',
  'rawTranscriptMode'
] as const;

/** The typed fields FR-R3-143 added. Absent from both goldens by construction. */
const FIELDS_ADDED_BY_143 = [
  'cliInheritEnvironment',
  'cliEnvironmentMode',
  'cliEnvironmentAllowlist',
  'backendProbeTimeoutSeconds',
  'uiConfirmationsEnable',
  'multiRootSuppressWarning'
] as const;

/**
 * FR-R3-144 (T005) — three more, absent from the goldens for the same reason:
 * the goldens predate every feature that has added a field since, which is the
 * only property that makes them a comparison rather than a mirror.
 */
const FIELDS_ADDED_BY_144 = [
  'backendRunner',
  'spendMaxUsdPerRun',
  'spendMaxTokensPerRun'
] as const;

const NEW_FIELDS = [...FIELDS_ADDED_BY_143, ...FIELDS_ADDED_BY_144] as const;

interface Golden {
  readonly values: Readonly<Record<string, unknown>>;
  readonly scopes: Readonly<Record<string, string>>;
}

/** Nothing written at any scope — a `settings.json` the operator never touched. */
const UNTOUCHED: Golden = {
  values: {
    cliPath: 'claude',
    codexPath: 'codex',
    agyPath: 'agy',
    loggingVerbose: false,
    loopMaxIterations: 10,
    invocationIdleTimeoutSeconds: 5400,
    invocationMaxDurationSeconds: 21600,
    watchdogPollIntervalMinutes: 30,
    auditRotationSizeMB: 5,
    auditRotationMaxAgeDays: 30,
    defaultPipelineId: '',
    fatalSignatures: [],
    // Present as a key, `undefined` as a value: the only `allowClear` spec in
    // the set, so it is the one field where "absent" and "unset" differ.
    claudeAutoCompactPctOverride: undefined,
    runtimeLogLevel: 'INFO',
    runtimeLogFilePath: '',
    retryMaxAttempts: 5,
    retryForceContinueOnCap: false,
    runtimeLogMaxBytes: 5242880,
    runtimeLogMaxGenerations: 3,
    sessionRetentionMaxAgeDays: 30,
    sessionRetentionMaxBytes: 536870912,
    rawTranscriptMode: 'errors-only'
  },
  scopes: Object.fromEntries(BASE_FIELDS.map((field) => [field, 'default']))
};

/**
 * A written-on config, because the untouched case exercises only the
 * `defaultValue` branch of every validator. This one drives four more paths that
 * a shared-validator edit would land in first: a user-scope value winning, a
 * workspace-scope value winning, an out-of-range value being replaced by its
 * default (`loop.maxIterations` 99999, `retry.maxAttempts` 9 against a cap of
 * 5), and — the one worth stating out loud — a **scope that keeps reporting
 * where the value was written even when the value itself was rejected**.
 * `retryMaxAttempts` below is `5` at scope `workspace`.
 */
const CONFIGURED: Golden = {
  values: {
    cliPath: '/opt/claude',
    codexPath: 'codex',
    agyPath: 'agy',
    loggingVerbose: true,
    loopMaxIterations: 10,
    invocationIdleTimeoutSeconds: 5400,
    invocationMaxDurationSeconds: 21600,
    watchdogPollIntervalMinutes: 30,
    auditRotationSizeMB: 5,
    auditRotationMaxAgeDays: 30,
    defaultPipelineId: '',
    fatalSignatures: ['boom'],
    claudeAutoCompactPctOverride: 80,
    runtimeLogLevel: 'INFO',
    runtimeLogFilePath: '',
    retryMaxAttempts: 5,
    retryForceContinueOnCap: false,
    runtimeLogMaxBytes: 5242880,
    runtimeLogMaxGenerations: 3,
    sessionRetentionMaxAgeDays: 30,
    sessionRetentionMaxBytes: 536870912,
    rawTranscriptMode: 'always'
  },
  scopes: {
    cliPath: 'user',
    codexPath: 'default',
    agyPath: 'default',
    loggingVerbose: 'workspace',
    loopMaxIterations: 'workspace',
    invocationIdleTimeoutSeconds: 'default',
    invocationMaxDurationSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultPipelineId: 'default',
    fatalSignatures: 'workspace',
    claudeAutoCompactPctOverride: 'user',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    retryMaxAttempts: 'workspace',
    retryForceContinueOnCap: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default',
    rawTranscriptMode: 'workspace'
  }
};

const WORKSPACE_VALUES: Record<string, unknown> = {
  'logging.verbose': true,
  'logging.rawTranscriptMode': 'always',
  'retry.maxAttempts': 9,
  'loop.maxIterations': 99999,
  fatalSignatures: ['boom']
};

const GLOBAL_VALUES: Record<string, unknown> = {
  'cli.path': '/opt/claude',
  'claude.autoCompactPctOverride': 80
};

/**
 * The stubs the goldens were captured against. `get` returns the effective
 * value the way `vscode.WorkspaceConfiguration` would (workspace over global
 * over default); `inspect` reports which layers hold one.
 *
 * `inspect` builds its result by ADDING the keys that exist rather than by
 * assigning `undefined` to the ones that do not, because that is what the real
 * `vscode.WorkspaceConfiguration.inspect` returns — a layer with no value is an
 * absent key, not a present one holding `undefined`. The distinction is exactly
 * what `exactOptionalPropertyTypes` measures, and
 * `tests/lint/compiler-strictness-ratchet.test.ts` counts a stub that blurs it
 * as one more site to fix later.
 */
function stubConfig(
  workspace: Record<string, unknown>,
  global: Record<string, unknown>
): GeneralSettingsConfig {
  return {
    get: <T,>(key: string, defaultValue: T): T => {
      if (key in workspace) return workspace[key] as T;
      if (key in global) return global[key] as T;
      return defaultValue;
    },
    inspect: <T,>(key: string) => {
      const result: { globalValue?: T; workspaceValue?: T } = {};
      if (key in workspace) result.workspaceValue = workspace[key] as T;
      if (key in global) result.globalValue = global[key] as T;
      return result;
    },
    update: async () => {}
  };
}

type Projection = Record<string, unknown> & { scopes: Record<string, string> };

function project(
  workspace: Record<string, unknown> = {},
  global: Record<string, unknown> = {}
): Projection {
  return readGeneralSettings(stubConfig(workspace, global)) as unknown as Projection;
}

describe('FR-R3-143 — the six new keys did not move the 22 that were already there', () => {
  const cases = [
    { name: 'an untouched settings.json', golden: UNTOUCHED, workspace: {}, global: {} },
    {
      name: 'a settings.json with values at both scopes',
      golden: CONFIGURED,
      workspace: WORKSPACE_VALUES,
      global: GLOBAL_VALUES
    }
  ] as const;

  for (const { name, golden, workspace, global } of cases) {
    describe(name, () => {
      it('projects every pre-existing field to the value it projected before', () => {
        const now = project(workspace, global);
        for (const field of BASE_FIELDS) {
          expect(
            now[field],
            `${field} moved. This is the projection the webview renders; it was captured from ` +
              'the module as it stood at the base commit, so a change here is a change adding ' +
              'the six new keys made to an old one.'
          ).toEqual(golden.values[field]);
        }
      });

      it('reports every pre-existing field at the scope it reported before', () => {
        const now = project(workspace, global);
        for (const field of BASE_FIELDS) {
          expect(now.scopes[field], `${field} changed scope`).toBe(golden.scopes[field]);
        }
      });

      it('keeps `claudeAutoCompactPctOverride` a present key with an undefined value', () => {
        const now = project(workspace, global);
        expect(
          Object.hasOwn(now, 'claudeAutoCompactPctOverride'),
          'dropping the key entirely is a different payload from clearing it, and the tab ' +
            'distinguishes the two'
        ).toBe(true);
        expect(now.claudeAutoCompactPctOverride).toEqual(
          golden.values.claudeAutoCompactPctOverride
        );
      });
    });
  }

  // Without this, the two blocks above would pass just as well against a golden
  // that happened to be today's output — the comparison would be with itself.
  it('compares against a record that predates every field added since', () => {
    for (const field of NEW_FIELDS) {
      expect(
        Object.hasOwn(UNTOUCHED.values, field),
        `${field} is in the golden. The golden is meant to be the pre-feature projection; ` +
          'a new field appearing in it means it was regenerated from current code, and the ' +
          'no-drift assertions above stopped comparing anything.'
      ).toBe(false);
      expect(Object.hasOwn(CONFIGURED.values, field)).toBe(false);
    }
  });

  it('projects the new fields today, so the delta is an addition and nothing else', () => {
    const now = project();
    for (const field of NEW_FIELDS) {
      expect(Object.hasOwn(now, field), `${field} is not projected`).toBe(true);
    }
    const projected = Object.keys(now).filter((key) => key !== 'scopes');
    expect(
      projected.sort(),
      `the projection is exactly the ${BASE_FIELDS.length} old fields plus the ` +
        `${NEW_FIELDS.length} added since — a field arriving from anywhere else is ` +
        'unaccounted for'
    ).toEqual([...BASE_FIELDS, ...NEW_FIELDS].sort());
    expect(projected).toHaveLength(Object.keys(KEY_SPECS).length);
  });
});
