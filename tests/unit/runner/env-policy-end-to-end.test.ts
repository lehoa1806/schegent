/**
 * FR-R7-18 (`N07`, FR-007, SC-007, Contract 5) — End-to-end environment-policy precedence trace.
 *
 * Traces conflicting and malformed `WorkspaceConfiguration` inputs from
 * `readProcessEnvironmentPolicy` through `policyRequestFields` and `buildSpawnEnv`
 * across all spawn consumers:
 *   - backend runners (`claude`, `codex`, `agy` invocation shape)
 *   - ACP bridge / native ACP transport (`AcpBackedRunner` passes `request` to `buildSpawnEnv`)
 *   - CLI version probe and backend capability probe
 *   - isolated execution-lane verification checks (`createSpawnCheck`, which intentionally
 *     retains `REQUIRED_PROCESS_ENV_NAMES` bootstrap variables under both `'minimal'` and
 *     `'allowlist'` while still excluding non-allowlisted ambient secrets)
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { readProcessEnvironmentPolicy } from '../../../src/activation/uncached-settings-accessors';
import { readGeneralSettings } from '../../../src/config/general-settings';
import { resolveProcessEnvironmentPolicy } from '../../../src/contracts/process-environment-policy';
import {
  buildSpawnEnv,
  policyRequestFields,
  REQUIRED_PROCESS_ENV_NAMES
} from '../../../src/runner/spawn-env';
import { createSpawnCheck } from '../../../src/services/execution-lanes/verification-runner';

const SENTINEL_SECRET = 'AWS_SECRET_ACCESS_KEY';
const ALLOWLISTED_CREDENTIAL = 'ANTHROPIC_API_KEY';

function createConfig(values: Readonly<Record<string, unknown>>): vscode.WorkspaceConfiguration {
  return {
    get<T>(key: string, defaultValue?: T): T {
      const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
      return (value !== undefined ? value : defaultValue) as T;
    },
    has(key: string): boolean {
      return Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined;
    },
    inspect() {
      return undefined;
    },
    async update() {
      return undefined;
    }
  };
}

function makeBaseEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const name of REQUIRED_PROCESS_ENV_NAMES) {
    base[name] = `bootstrap-${name}`;
  }
  base.LC_CTYPE = 'en_US.UTF-8';
  base[ALLOWLISTED_CREDENTIAL] = 'synthetic-allowlisted-token';
  base[SENTINEL_SECRET] = 'synthetic-ambient-secret';
  base.UNRELATED_AMBIENT_VAR = 'synthetic-unrelated';
  return base;
}

async function captureLaneCheckEnv(
  config: vscode.WorkspaceConfiguration,
  baseEnv: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | undefined;
  const fakeSpawn = (_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
    captured = options.env;
    const child = new EventEmitter() as unknown as ChildProcess & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: undefined;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  };

  const spawnCheck = createSpawnCheck({
    spawn: fakeSpawn,
    baseEnv,
    environmentPolicy: () => readProcessEnvironmentPolicy('/workspace', config)
  });

  const result = await spawnCheck(['/usr/bin/env', 'true'], {
    cwd: '/workspace',
    timeoutMs: 5_000
  });
  expect(result.exitCode).toBe(0);
  expect(captured).toBeDefined();
  return captured!;
}

function buildAllConsumerEnvs(
  config: vscode.WorkspaceConfiguration,
  baseEnv: NodeJS.ProcessEnv
): {
  readonly backendRunner: NodeJS.ProcessEnv;
  readonly acpBridge: NodeJS.ProcessEnv;
  readonly cliVersionProbe: NodeJS.ProcessEnv;
  readonly capabilityProbe: NodeJS.ProcessEnv;
} {
  const policy = readProcessEnvironmentPolicy('/workspace', config);
  const fields = policyRequestFields(policy);
  return {
    backendRunner: buildSpawnEnv(
      { env: { SCHEGENT_PHASE: 'implement', SCHEGENT_ITERATION: '1' }, ...fields },
      baseEnv
    ),
    acpBridge: buildSpawnEnv(
      { env: { SCHEGENT_PHASE: 'plan', SCHEGENT_ITERATION: '2' }, ...fields },
      baseEnv
    ),
    cliVersionProbe: buildSpawnEnv(fields, baseEnv),
    capabilityProbe: buildSpawnEnv(
      { env: { SCHEGENT_PHASE: 'runner-probe', SCHEGENT_ITERATION: '0' }, ...fields },
      baseEnv
    )
  };
}

describe('FR-R7-18 N07 — environment policy precedence end-to-end', () => {
  it('defaults unset configuration to allowlist with empty allowlist (bootstrap + LC_* only, zero ambient secrets)', async () => {
    const config = createConfig({});
    const baseEnv = makeBaseEnv();
    const policy = readProcessEnvironmentPolicy('/workspace', config);

    expect(policy).toEqual({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: []
    });

    const envs = buildAllConsumerEnvs(config, baseEnv);
    for (const env of Object.values(envs)) {
      for (const name of REQUIRED_PROCESS_ENV_NAMES) {
        expect(env[name], `expected bootstrap ${name}`).toBe(`bootstrap-${name}`);
      }
      expect(env.LC_CTYPE).toBe('en_US.UTF-8');
      expect(env[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
      expect(env[SENTINEL_SECRET]).toBeUndefined();
    }

    const laneEnv = await captureLaneCheckEnv(config, baseEnv);
    for (const name of REQUIRED_PROCESS_ENV_NAMES) {
      expect(laneEnv[name]).toBe(`bootstrap-${name}`);
    }
    expect(laneEnv.LC_CTYPE).toBe('en_US.UTF-8');
    expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
    expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
  });

  it.each(['inherit', 'allowlist'] as const)(
    'inheritEnvironment: false overrides environmentMode=%s and drops non-empty allowlist',
    async (mode) => {
      const config = createConfig({
        'cli.inheritEnvironment': false,
        'cli.environmentMode': mode,
        'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL]
      });
      const baseEnv = makeBaseEnv();
      const policy = readProcessEnvironmentPolicy('/workspace', config);

      expect(policy).toEqual({ mode: 'minimal', inheritProcessEnv: false });
      expect(policy.processEnvAllowlist).toBeUndefined();

      const projected = readGeneralSettings(config);
      expect(projected.cliInheritEnvironment).toBe(false);
      expect(
        resolveProcessEnvironmentPolicy({
          inheritEnvironment: projected.cliInheritEnvironment,
          mode: projected.cliEnvironmentMode,
          allowlist: projected.cliEnvironmentAllowlist
        })
      ).toEqual(policy);

      const envs = buildAllConsumerEnvs(config, baseEnv);
      expect(envs.backendRunner).toEqual({ SCHEGENT_PHASE: 'implement', SCHEGENT_ITERATION: '1' });
      expect(envs.acpBridge).toEqual({ SCHEGENT_PHASE: 'plan', SCHEGENT_ITERATION: '2' });
      expect(envs.cliVersionProbe).toEqual({});
      expect(envs.capabilityProbe).toEqual({ SCHEGENT_PHASE: 'runner-probe', SCHEGENT_ITERATION: '0' });

      // Lane verification retains REQUIRED_PROCESS_ENV_NAMES bootstrap variables under minimal,
      // while still dropping BOTH non-allowlisted secrets AND the overridden operator allowlist.
      const laneEnv = await captureLaneCheckEnv(config, baseEnv);
      for (const name of REQUIRED_PROCESS_ENV_NAMES) {
        expect(laneEnv[name], `lane check must keep bootstrap ${name}`).toBe(`bootstrap-${name}`);
      }
      expect(laneEnv.LC_CTYPE).toBe('en_US.UTF-8');
      expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
      expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
    }
  );

  it('inheritEnvironment: true + mode: minimal drops bootstrap and allowlist for runners/ACP/probes, keeps bootstrap only for lane checks', async () => {
    const config = createConfig({
      'cli.inheritEnvironment': true,
      'cli.environmentMode': 'minimal',
      'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL]
    });
    const baseEnv = makeBaseEnv();
    const policy = readProcessEnvironmentPolicy('/workspace', config);

    expect(policy).toEqual({ mode: 'minimal', inheritProcessEnv: false });

    const envs = buildAllConsumerEnvs(config, baseEnv);
    for (const env of Object.values(envs)) {
      expect(env.PATH).toBeUndefined();
      expect(env.USER).toBeUndefined();
      expect(env[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
      expect(env[SENTINEL_SECRET]).toBeUndefined();
    }

    const laneEnv = await captureLaneCheckEnv(config, baseEnv);
    for (const name of REQUIRED_PROCESS_ENV_NAMES) {
      expect(laneEnv[name]).toBe(`bootstrap-${name}`);
    }
    expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
    expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
  });

  it('inheritEnvironment: true + mode: allowlist forwards bootstrap, LC_*, and valid allowlisted names only', async () => {
    const config = createConfig({
      'cli.inheritEnvironment': true,
      'cli.environmentMode': 'allowlist',
      'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL, ALLOWLISTED_CREDENTIAL, 'INVALID=NAME', '']
    });
    const baseEnv = makeBaseEnv();
    const policy = readProcessEnvironmentPolicy('/workspace', config);

    expect(policy).toEqual({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: [ALLOWLISTED_CREDENTIAL]
    });

    const envs = buildAllConsumerEnvs(config, baseEnv);
    for (const env of Object.values(envs)) {
      expect(env.USER).toBe('bootstrap-USER');
      expect(env.LOGNAME).toBe('bootstrap-LOGNAME');
      expect(env.USERNAME).toBe('bootstrap-USERNAME');
      expect(env[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
      expect(env[SENTINEL_SECRET]).toBeUndefined();
      expect(env.UNRELATED_AMBIENT_VAR).toBeUndefined();
    }

    const laneEnv = await captureLaneCheckEnv(config, baseEnv);
    for (const name of REQUIRED_PROCESS_ENV_NAMES) {
      expect(laneEnv[name]).toBe(`bootstrap-${name}`);
    }
    expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
    expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
  });

  it('inheritEnvironment: true + exact mode: inherit forwards the full ambient environment to all consumers', async () => {
    const config = createConfig({
      'cli.inheritEnvironment': true,
      'cli.environmentMode': 'inherit',
      'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL]
    });
    const baseEnv = makeBaseEnv();
    const policy = readProcessEnvironmentPolicy('/workspace', config);

    expect(policy).toEqual({ mode: 'inherit', inheritProcessEnv: true });
    expect(policy.processEnvAllowlist).toBeUndefined();

    const envs = buildAllConsumerEnvs(config, baseEnv);
    for (const env of Object.values(envs)) {
      expect(env[SENTINEL_SECRET]).toBe('synthetic-ambient-secret');
      expect(env[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
      expect(env.UNRELATED_AMBIENT_VAR).toBe('synthetic-unrelated');
    }

    const laneEnv = await captureLaneCheckEnv(config, baseEnv);
    expect(laneEnv[SENTINEL_SECRET]).toBe('synthetic-ambient-secret');
    expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
    expect(laneEnv.PATH).toBe('bootstrap-PATH');
  });

  it.each([
    ['string "false"', 'false'],
    ['string "true"', 'true'],
    ['number 1', 1],
    ['number 0', 0],
    ['null', null],
    ['object', {}],
    ['array', []]
  ] as const)(
    'non-boolean cli.inheritEnvironment (%s) fails closed to minimal even when mode is inherit',
    async (_label, malformedInherit) => {
      const config = createConfig({
        'cli.inheritEnvironment': malformedInherit,
        'cli.environmentMode': 'inherit',
        'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL]
      });
      const baseEnv = makeBaseEnv();
      const policy = readProcessEnvironmentPolicy('/workspace', config);

      expect(policy).toEqual({ mode: 'minimal', inheritProcessEnv: false });
      expect(policy.processEnvAllowlist).toBeUndefined();

      // Settings UI snapshot projection + direct contract resolution must agree with host spawn.
      const projected = readGeneralSettings(config);
      expect(projected.cliInheritEnvironment).toBe(false);
      expect(
        resolveProcessEnvironmentPolicy({
          inheritEnvironment: projected.cliInheritEnvironment,
          mode: projected.cliEnvironmentMode,
          allowlist: projected.cliEnvironmentAllowlist
        })
      ).toEqual(policy);
      expect(
        resolveProcessEnvironmentPolicy({
          inheritEnvironment: malformedInherit,
          mode: 'inherit',
          allowlist: [ALLOWLISTED_CREDENTIAL]
        })
      ).toEqual(policy);

      const envs = buildAllConsumerEnvs(config, baseEnv);
      for (const env of Object.values(envs)) {
        expect(env[SENTINEL_SECRET]).toBeUndefined();
        expect(env[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
        expect(env.PATH).toBeUndefined();
      }

      const laneEnv = await captureLaneCheckEnv(config, baseEnv);
      for (const name of REQUIRED_PROCESS_ENV_NAMES) {
        expect(laneEnv[name]).toBe(`bootstrap-${name}`);
      }
      expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
      expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBeUndefined();
    }
  );

  it.each([
    ['capitalized Inherit', 'Inherit'],
    ['uppercase INHERIT', 'INHERIT'],
    ['leading space', ' inherit'],
    ['typo inherits', 'inherits'],
    ['empty string', ''],
    ['null', null],
    ['number', 42],
    ['object', {}]
  ] as const)(
    'malformed or mis-cased environmentMode (%s) falls back to allowlist and never inherits ambient secrets',
    async (_label, malformedMode) => {
      const config = createConfig({
        'cli.inheritEnvironment': true,
        'cli.environmentMode': malformedMode,
        'cli.environmentAllowlist': [ALLOWLISTED_CREDENTIAL]
      });
      const baseEnv = makeBaseEnv();
      const policy = readProcessEnvironmentPolicy('/workspace', config);

      expect(policy).toEqual({
        mode: 'allowlist',
        inheritProcessEnv: false,
        processEnvAllowlist: [ALLOWLISTED_CREDENTIAL]
      });

      const envs = buildAllConsumerEnvs(config, baseEnv);
      for (const env of Object.values(envs)) {
        expect(env.PATH).toBe('bootstrap-PATH');
        expect(env[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
        expect(env[SENTINEL_SECRET]).toBeUndefined();
      }

      const laneEnv = await captureLaneCheckEnv(config, baseEnv);
      expect(laneEnv.PATH).toBe('bootstrap-PATH');
      expect(laneEnv[ALLOWLISTED_CREDENTIAL]).toBe('synthetic-allowlisted-token');
      expect(laneEnv[SENTINEL_SECRET]).toBeUndefined();
    }
  );
});
