// FR-R7-06 (SC-003, FR-001, FR-002, FR-008) — parity snapshot, immutability, pure-data,
// and unknown-safety tests for `src/contracts/backend-descriptors.ts`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { KEY_SPECS, type AllowedKey } from '../../../src/config/general-settings-keys';
import {
  BACKEND_DESCRIPTORS,
  BACKEND_DESCRIPTOR_LIST,
  EMPTY_BACKEND_MODELS,
  emptyBackendModels,
  findBackendDescriptor,
  getBackendDescriptor,
  isUnsupportedEffortForBackend,
  mapBackends,
  mapMutableBackends,
  type BackendDescriptor
} from '../../../src/contracts/backend-descriptors';

const DESCRIPTOR_SOURCE = readFileSync(
  resolve(__dirname, '../../../src/contracts/backend-descriptors.ts'),
  'utf8'
);

/** Recursively asserts that a value contains zero function-valued fields and is frozen. */
function assertPureFrozenData(value: unknown, path: string): void {
  expect(typeof value, `${path} must not be a function`).not.toBe('function');
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `${path} must be frozen`).toBe(true);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureFrozenData(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertPureFrozenData(child, `${path}.${key}`);
  }
}

describe('FR-R7-06 — BackendDescriptor table parity, purity, and unknown-safety', () => {
  it('SC-003: matches every pre-migration setting key, label, default, flag, and capability across all three backends', () => {
    const expected: Record<BackendRunnerKind, BackendDescriptor> = {
      claude: {
        kind: 'claude',
        displayLabel: 'Claude',
        runnerLabel: 'claude-cli',
        cliPathSettingKey: 'cli.path',
        cliPathFieldKey: 'cliPath',
        cliPathDocLabel: 'Claude CLI binary path',
        defaultCliBinary: 'claude',
        usesLegacyFallbackPath: true,
        containmentMechanism: 'none',
        defaultAuditPermissionMode: 'unrestricted',
        confirmedFlags: ['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode'],
        unboundedFlags: ['--dangerously-skip-permissions'],
        spendDenomination: 'usd',
        qualifiedCliVersion: '2.1.302',
        acpProfile: {
          profileId: 'claude-acp-bridge',
          revision: 1,
          kind: 'bridge',
          provider: 'anthropic',
          executableRef: 'claude',
          requiredCapabilities: ['load-session', 'embedded-context'],
          nativeStdioArgs: null
        },
        ambientConfigSegments: ['.claude', 'settings.json'],
        repoAgentConfigPaths: [
          '.claude/settings.json',
          '.claude/settings.local.json',
          '.mcp.json',
          'CLAUDE.md',
          '.claude/CLAUDE.md',
          '.claude/skills/',
          '.claude/commands/',
          '.claude/agents/',
          '.claude/hooks/'
        ],
        supportsGitSideEffects: true,
        supportsAutoCompactOverride: true,
        supportsSessionCompaction: true,
        modelDiscoveryArgs: null,
        unsupportedEffortLevels: [],
        exampleModelPlaceholder: 'claude-3-7-sonnet-20250219'
      },
      codex: {
        kind: 'codex',
        displayLabel: 'Codex',
        runnerLabel: 'codex-cli',
        cliPathSettingKey: 'codex.path',
        cliPathFieldKey: 'codexPath',
        cliPathDocLabel: 'Codex CLI binary path',
        defaultCliBinary: 'codex',
        usesLegacyFallbackPath: false,
        containmentMechanism: 'codex-sandbox-workspace-write',
        defaultAuditPermissionMode: 'workspace-write',
        confirmedFlags: ['--sandbox'],
        unboundedFlags: ['--sandbox', 'workspace-write'],
        spendDenomination: 'tokens',
        qualifiedCliVersion: '0.159.2',
        acpProfile: {
          profileId: 'codex-acp-bridge',
          revision: 1,
          kind: 'bridge',
          provider: 'openai',
          executableRef: 'codex',
          requiredCapabilities: ['load-session', 'embedded-context'],
          nativeStdioArgs: null
        },
        ambientConfigSegments: ['.codex', 'config.toml'],
        repoAgentConfigPaths: ['.codex/config.toml', 'AGENTS.md', 'AGENTS.override.md'],
        supportsGitSideEffects: false,
        supportsAutoCompactOverride: false,
        supportsSessionCompaction: false,
        modelDiscoveryArgs: null,
        unsupportedEffortLevels: [],
        exampleModelPlaceholder: 'model-name'
      },
      agy: {
        kind: 'agy',
        displayLabel: 'Agy',
        runnerLabel: 'agy-cli',
        cliPathSettingKey: 'agy.path',
        cliPathFieldKey: 'agyPath',
        cliPathDocLabel: 'Agy CLI binary path',
        defaultCliBinary: 'agy',
        usesLegacyFallbackPath: false,
        containmentMechanism: 'none',
        defaultAuditPermissionMode: 'unrestricted',
        confirmedFlags: ['--dangerously-skip-permissions', '--mode', '--sandbox'],
        unboundedFlags: ['--dangerously-skip-permissions'],
        spendDenomination: 'tokens',
        qualifiedCliVersion: '1.4.2',
        acpProfile: {
          profileId: 'agy-acp-native',
          revision: 1,
          kind: 'native',
          provider: 'google',
          executableRef: 'agy',
          requiredCapabilities: ['load-session', 'embedded-context'],
          nativeStdioArgs: ['acp', '--stdio', '--disable-telemetry']
        },
        ambientConfigSegments: null,
        repoAgentConfigPaths: [
          'AGENTS.md',
          'GEMINI.md',
          '.agents/skills/',
          '.agents/rules/',
          '.agents/workflows/',
          '.gemini/settings.json'
        ],
        supportsGitSideEffects: true,
        supportsAutoCompactOverride: false,
        supportsSessionCompaction: false,
        modelDiscoveryArgs: ['models'],
        unsupportedEffortLevels: ['xhigh', 'max'],
        exampleModelPlaceholder: 'model-name'
      }
    };

    expect(Object.keys(BACKEND_DESCRIPTORS)).toEqual([...SUPPORTED_BACKENDS]);
    expect(BACKEND_DESCRIPTOR_LIST.map((d) => d.kind)).toEqual([...SUPPORTED_BACKENDS]);
    expect(BACKEND_DESCRIPTORS).toEqual(expected);
  });

  it('FR-008: contains pure deeply frozen data with zero function fields and zero acting-layer imports', () => {
    assertPureFrozenData(BACKEND_DESCRIPTORS, 'BACKEND_DESCRIPTORS');
    assertPureFrozenData(BACKEND_DESCRIPTOR_LIST, 'BACKEND_DESCRIPTOR_LIST');
    assertPureFrozenData(EMPTY_BACKEND_MODELS, 'EMPTY_BACKEND_MODELS');

    const imports = [...DESCRIPTOR_SOURCE.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, `backend-descriptors.ts must only import sibling contracts: ${specifier}`).toMatch(
        /^\.\/[a-z-]+$/
      );
    }
  });

  it('FR-002: findBackendDescriptor returns explicit undefined for unknown or prototype keys and never falls back to claude', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      const found = findBackendDescriptor(kind);
      expect(found).toBe(BACKEND_DESCRIPTORS[kind]);
      expect(getBackendDescriptor(kind)).toBe(BACKEND_DESCRIPTORS[kind]);
    }

    const unknowns: readonly unknown[] = [
      '',
      'unknown',
      'gemini',
      'Claude',
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      null,
      undefined,
      42,
      {},
      []
    ];
    for (const bad of unknowns) {
      expect(findBackendDescriptor(bad), `findBackendDescriptor(${String(bad)})`).toBeUndefined();
      expect(
        () => getBackendDescriptor(bad as BackendRunnerKind),
        `getBackendDescriptor(${String(bad)}) must throw`
      ).toThrow(TypeError);
    }
  });

  it('evaluates unsupported effort levels via descriptor data', () => {
    expect(isUnsupportedEffortForBackend('agy', 'xhigh')).toBe(true);
    expect(isUnsupportedEffortForBackend('agy', 'max')).toBe(true);
    expect(isUnsupportedEffortForBackend('agy', 'high')).toBe(false);
    expect(isUnsupportedEffortForBackend('claude', 'max')).toBe(false);
    expect(isUnsupportedEffortForBackend('codex', 'xhigh')).toBe(false);
    expect(isUnsupportedEffortForBackend('unknown', 'max')).toBe(false);
  });

  it('constructs exhaustive frozen and mutable maps in canonical order', () => {
    const labels = mapBackends((d) => d.displayLabel);
    expect(Object.isFrozen(labels)).toBe(true);
    expect(Object.keys(labels)).toEqual([...SUPPORTED_BACKENDS]);
    expect(labels).toEqual({ claude: 'Claude', codex: 'Codex', agy: 'Agy' });

    const mutable = mapMutableBackends(() => [] as string[]);
    expect(Object.isFrozen(mutable)).toBe(false);
    mutable.claude.push('test-model');
    expect(mutable.claude).toEqual(['test-model']);
    expect(mutable.codex).toEqual([]);

    expect(emptyBackendModels()).toEqual({ claude: [], codex: [], agy: [] });
  });

  it('keeps cliPathSettingKey, cliPathFieldKey, and defaultCliBinary aligned with KEY_SPECS', () => {
    for (const descriptor of BACKEND_DESCRIPTOR_LIST) {
      const spec = Object.getOwnPropertyDescriptor(
        KEY_SPECS,
        descriptor.cliPathSettingKey as AllowedKey
      )?.value as { readonly typedField: string; readonly defaultValue: unknown } | undefined;
      expect(spec, `KEY_SPECS entry for ${descriptor.cliPathSettingKey}`).toBeDefined();
      expect(spec?.typedField).toBe(descriptor.cliPathFieldKey);
      expect(spec?.defaultValue).toBe(descriptor.defaultCliBinary);
    }
  });

  it('FR-R7-11: validateSettingsSchemaParity validates effective backend-valued settings metadata and rejects drift', async () => {
    const repoRoot = resolve(__dirname, '../../..');
    const emitterUrl = pathToFileURL(
      resolve(repoRoot, 'scripts/contracts/emit-backend-descriptors.mjs')
    ).href;
    const emitter = (await import(emitterUrl)) as {
      extractBackendDescriptorTable: (root: string) => {
        unionMembers: string[];
        supportedBackends: string[];
        defaultBackend: string;
        descriptors: Record<string, unknown>;
      };
      validateBackendManifestParity: (args: Record<string, unknown>) => void;
      validateSettingsSchemaParity: (
        root: string,
        args: Record<string, unknown>
      ) => void;
    };

    const descriptorData = emitter.extractBackendDescriptorTable(repoRoot);
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
    ) as Record<string, unknown>;
    const settingsSchemaSource = readFileSync(
      resolve(repoRoot, 'src/config/settings-schema.ts'),
      'utf8'
    );

    // Positive control: current repo passes both manifest and settings-schema parity.
    expect(() =>
      emitter.validateBackendManifestParity({ ...descriptorData, packageJson })
    ).not.toThrow();
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: settingsSchemaSource
      })
    ).not.toThrow();

    // Negative control 1: dropping `itemEnum` from schegent.backend.uncontainedBackends.
    const droppedItemEnum = settingsSchemaSource.replace(
      /\s*itemEnum:\s*SUPPORTED_BACKENDS,/,
      ''
    );
    expect(droppedItemEnum).not.toEqual(settingsSchemaSource);
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: droppedItemEnum
      })
    ).toThrow(/uncontainedBackends.*itemEnum/i);

    // Negative control 2: hardcoding `itemEnum` as a literal array instead of SUPPORTED_BACKENDS.
    const hardcodedItemEnum = settingsSchemaSource.replace(
      'itemEnum: SUPPORTED_BACKENDS',
      "itemEnum: ['claude', 'codex', 'agy']"
    );
    expect(hardcodedItemEnum).not.toEqual(settingsSchemaSource);
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: hardcodedItemEnum
      })
    ).toThrow(/uncontainedBackends\.itemEnum must reference SUPPORTED_BACKENDS/);

    // Negative control 3: drifting schegent.backend.runner default away from DEFAULT_BACKEND.
    const driftedRunnerDefault = settingsSchemaSource.replace(
      'default: DEFAULT_BACKEND',
      "default: 'codex'"
    );
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: driftedRunnerDefault
      })
    ).toThrow(/schegent\.backend\.runner\.default/);

    // Negative control 4: drifting schegent.models default away from emptyBackendModels().
    const driftedModels = settingsSchemaSource.replace(
      'default: emptyBackendModels()',
      'default: { claude: [], codex: [], agy: [] }'
    );
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: driftedModels
      })
    ).toThrow(/schegent\.models\.default must call emptyBackendModels/);

    // Negative control 5: drifting schegent.acp.profile enum (omitting 'auto').
    const driftedAcp = settingsSchemaSource.replace(
      "enum: Object.freeze([\n      'auto',",
      'enum: Object.freeze(['
    );
    expect(driftedAcp).not.toEqual(settingsSchemaSource);
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: driftedAcp
      })
    ).toThrow(/schegent\.acp\.profile\.enum/);

    // Negative control 6: drifting a CLI path entry's docLabel away from BACKEND_DESCRIPTORS.
    const driftedCliDoc = settingsSchemaSource.replace(
      'docLabel: BACKEND_DESCRIPTORS.codex.cliPathDocLabel',
      "docLabel: 'Codex binary'"
    );
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson,
        schemaText: driftedCliDoc
      })
    ).toThrow(/schegent\.codex\.path\.docLabel/);

    // Negative control 7: drifting package.json uncontainedBackends items.enum.
    const driftedPkg = structuredClone(packageJson) as {
      contributes: {
        configuration: {
          properties: Record<string, { items?: { enum?: string[] } }>;
        };
      };
    };
    driftedPkg.contributes.configuration.properties[
      'schegent.backend.uncontainedBackends'
    ]!.items!.enum = ['claude', 'codex'];
    expect(() =>
      emitter.validateSettingsSchemaParity(repoRoot, {
        ...descriptorData,
        packageJson: driftedPkg,
        schemaText: settingsSchemaSource
      })
    ).toThrow(/uncontainedBackends\.itemEnum disagrees with package\.json/);
  });
});
