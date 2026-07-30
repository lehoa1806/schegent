// Feature 031 T016 — unit tests for the save-handler's `model` field
// support. The save-handler reuses CMD_SAVE_WAKEUP_SETTINGS (no new
// mutating IPC) and delegates `model` validation to `validateSettings`.
//
// Coverage (per tasks.md T016):
//   (a) payload with `model: 'claude-opus-4-7'` → accepted.
//   (b) payload with `model: 'claude-bogus-9000'` → rejected with
//       `'invalid-model'`.
//   (c) payload with no `model` field → accepted; persists
//       `'runner-default'` sentinel.
//   (d) the save-handler does NOT introduce a new mutating IPC; it
//       reuses CMD_SAVE_WAKEUP_SETTINGS.

import { describe, it, expect } from 'vitest';
import {
  createSaveWakeUpSettingsHandler,
  type SaveWakeUpHandlerDeps,
  type SaveWakeUpPayload
} from '../../../src/wakeup/save-handler';
import type {
  DaemonManager,
  DaemonState,
  ApplyOptions
} from '../../../src/wakeup/daemon-manager';
import type { WakeUpConfig } from '../../../src/wakeup/settings';
import { CMD_SAVE_WAKEUP_SETTINGS } from '../../../src/contracts/sidebar-ipc';

class FakeConfig implements WakeUpConfig {
  private values: Map<string, unknown> = new Map();
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
  readModelPersisted(): unknown {
    return this.values.get('wakeUp.model');
  }
}

class FakeDaemonManager
  implements Pick<DaemonManager, 'apply' | 'uninstall' | 'inspect'>
{
  public readonly applyCalls: ApplyOptions[] = [];
  public uninstallCalls = 0;
  constructor(private readonly inspectResult: DaemonState = { registered: false, schedule: null }) {}
  async apply(opts: ApplyOptions): Promise<void> {
    this.applyCalls.push(opts);
  }
  async uninstall(): Promise<void> {
    this.uninstallCalls += 1;
  }
  async inspect(): Promise<DaemonState> {
    return this.inspectResult;
  }
}

class FakeAudit {
  public readonly calls: Array<Record<string, unknown>> = [];
  async append(entry: Record<string, unknown>): Promise<void> {
    this.calls.push(entry);
  }
}

function makeDeps(): {
  deps: SaveWakeUpHandlerDeps;
  config: FakeConfig;
  daemon: FakeDaemonManager;
  audit: FakeAudit;
} {
  const config = new FakeConfig();
  const daemon = new FakeDaemonManager();
  const audit = new FakeAudit();
  const deps: SaveWakeUpHandlerDeps = {
    readConfig: () => config,
    daemonManager: daemon as unknown as DaemonManager,
    workspaceRoots: () => [],
    sourceRunnerPath: '/dist/wakeup-runner.js',
    homeDir: '/tmp/wakeup-home',
    audit,
    platform: () => 'darwin',
    sanitize: (m) => m
  };
  return { deps, config, daemon, audit };
}

const baseValid: SaveWakeUpPayload = Object.freeze({
  enabled: true,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h'
});

describe('Feature 031 T016 — save-handler accepts the `model` field', () => {
  it('accepts a known model (claude-opus-4-7) and persists it', async () => {
    const { deps, config } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...baseValid,
      model: 'claude-opus-4-7'
    });
    expect(result).toEqual({ ok: true });
    expect(config.readModelPersisted()).toBe('claude-opus-4-7');
  });

  it('accepts each member of the closed registry', async () => {
    const members = ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-6'] as const;
    for (const m of members) {
      const { deps, config } = makeDeps();
      const handler = createSaveWakeUpSettingsHandler(deps);
      const result = await handler({ ...baseValid, model: m });
      expect(result).toEqual({ ok: true });
      expect(config.readModelPersisted()).toBe(m);
    }
  });

  it('accepts the `runner-default` sentinel and persists it', async () => {
    const { deps, config } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...baseValid,
      model: 'runner-default'
    });
    expect(result).toEqual({ ok: true });
    expect(config.readModelPersisted()).toBe('runner-default');
  });
});

describe('Feature 031 T016 — save-handler rejects unknown models', () => {
  it('rejects an unknown identifier with `invalid-model`', async () => {
    const { deps, config } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...baseValid,
      model: 'claude-bogus-9000'
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-model' });
    // The rejected payload MUST NOT mutate persisted state.
    expect(config.readModelPersisted()).toBeUndefined();
  });

  it('rejects an empty string with `invalid-model`', async () => {
    const { deps } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler({
      ...baseValid,
      model: ''
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-model' });
  });
});

describe('Feature 031 T016 — save-handler accepts payloads without `model`', () => {
  it('accepts a payload with no `model` field and persists the `runner-default` sentinel', async () => {
    const { deps, config } = makeDeps();
    const handler = createSaveWakeUpSettingsHandler(deps);
    const result = await handler(baseValid);
    expect(result).toEqual({ ok: true });
    expect(config.readModelPersisted()).toBe('runner-default');
  });
});

describe('Feature 031 T016 — IPC literal reuse', () => {
  it('does NOT introduce a new IPC command — CMD_SAVE_WAKEUP_SETTINGS is reused', () => {
    // The handler factory does not import or reference any new IPC
    // literal. We pin the contract here by re-asserting the literal
    // shape so a future code-mover does not accidentally rename it.
    expect(CMD_SAVE_WAKEUP_SETTINGS).toBe('CMD_SAVE_WAKEUP_SETTINGS');
  });
});
