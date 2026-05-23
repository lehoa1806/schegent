/**
 * Feature 056 Track 3 (FR-017, T028) — Settings defaults parity.
 *
 * Three things must agree on the same default/min/max for every
 * scalar setting under `schegent.*`:
 *   1. package.json `contributes.configuration.properties[...]`
 *      (the VS Code Settings UI surface).
 *   2. The host validator at `src/config/general-settings.ts`
 *      (`KEY_SPECS`).
 *   3. The webview idle snapshot at
 *      `webview-ui/src/lib/snapshot-types.ts` (`IDLE_GENERAL_SETTINGS`).
 *
 * Track 3 explicitly fixed three drifts:
 *   - `defaultPipelineId` host default was `'standard'` while the
 *     contribution and the webview idle snapshot were inconsistent.
 *   - `retry.maxAttempts.maximum` was `20` even though the effective
 *     cap (`DELAYED_RETRY_CAP` in retry-handler) saturates at 5.
 *   - `queue.globalConcurrencyCap.maximum` was `5`; v1 only ships
 *     single-active-run semantics so it must be pinned to `1`.
 *
 * This test pins those three values and rejects future drift on the
 * shared schema surface.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readPackageJson(): {
  contributes: {
    configuration: {
      properties: Record<
        string,
        {
          type?: string | string[];
          default?: unknown;
          minimum?: number;
          maximum?: number;
          enum?: readonly string[];
        }
      >;
    };
  };
} {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

describe('Feature 056 Track 3 — settings defaults parity', () => {
  it('package.json default pipeline id matches the host KEY_SPECS default', () => {
    const pkg = readPackageJson();
    const contrib = pkg.contributes.configuration.properties['schegent.defaultPipelineId'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe('dev-new-feature');
  });

  it('package.json retry.maxAttempts has maximum 5 (effective cap)', () => {
    const pkg = readPackageJson();
    const contrib = pkg.contributes.configuration.properties['schegent.retry.maxAttempts'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(5);
    expect(contrib.minimum).toBe(1);
    expect(contrib.maximum).toBe(5);
  });

  it('package.json queue.globalConcurrencyCap is pinned to [1, 1]', () => {
    const pkg = readPackageJson();
    const contrib =
      pkg.contributes.configuration.properties['schegent.queue.globalConcurrencyCap'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(1);
    expect(contrib.minimum).toBe(1);
    expect(contrib.maximum).toBe(1);
  });

  it('package.json runtimeLogMaxBytes is present with [64 KiB, 1 GiB] range', () => {
    const pkg = readPackageJson();
    const contrib = pkg.contributes.configuration.properties['schegent.logging.runtimeLogMaxBytes'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(5 * 1024 * 1024);
    expect(contrib.minimum).toBe(65536);
    expect(contrib.maximum).toBe(1073741824);
  });

  it('package.json runtimeLogMaxGenerations is present with [0, 20] range', () => {
    const pkg = readPackageJson();
    const contrib =
      pkg.contributes.configuration.properties['schegent.logging.runtimeLogMaxGenerations'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(3);
    expect(contrib.minimum).toBe(0);
    expect(contrib.maximum).toBe(20);
  });
});

describe('Feature 056 Track 3 — host validator agrees with package.json', () => {
  it('host KEY_SPECS imports cleanly and exposes the same defaults', async () => {
    // Import dynamically to avoid forcing the module under a side-effect
    // free CI load before all upstream modules exist.
    const mod = await import('../../src/config/general-settings.js');
    // The `KEY_SPECS` symbol is module-private; we observe defaults via
    // the idle projection helper exposed by readGeneralSettings against
    // a stub config that returns every default.
    const fakeConfig = {
      get<T>(_k: string, fallback: T): T {
        return fallback;
      },
      inspect<T>() {
        return undefined as unknown as
          | {
              defaultValue?: T;
              globalValue?: T;
              workspaceValue?: T;
              workspaceFolderValue?: T;
            }
          | undefined;
      },
      update() {
        return Promise.resolve();
      }
    };
    const settings = mod.readGeneralSettings(fakeConfig);
    expect(settings.defaultPipelineId).toBe('dev-new-feature');
    expect(settings.retryMaxAttempts).toBe(5);
    expect(settings.queueGlobalConcurrencyCap).toBe(1);
    expect(settings.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(settings.runtimeLogMaxGenerations).toBe(3);
  });
});

describe('Feature 056 Track 3 — webview idle snapshot agrees with host defaults', () => {
  it('host IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../src/ui/sidebar/snapshot.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('dev-new-feature');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.queueGlobalConcurrencyCap).toBe(1);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxGenerations).toBe(3);
  });

  it('webview IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('dev-new-feature');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.queueGlobalConcurrencyCap).toBe(1);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxGenerations).toBe(3);
  });
});

/**
 * Feature 056 Track 3 (FR-016) — Coverage guard.
 *
 * The Track 3 spot-checks above pin individual values for the three
 * Track 3 drift fixes plus the two runtime-log rotation keys. They do
 * NOT, on their own, satisfy FR-016's stronger contract:
 *
 *   "every Schegent setting in `package.json` has a matching entry in
 *    the host schema with identical default, type, and range."
 *
 * This coverage guard walks EVERY `schegent.*` key in package.json and
 * asserts each is owned by a known host-side validator. New keys that
 * land in the contribution metadata without a matching validator will
 * fail the build — the gap-analysis audit (2026-05-17) identified the
 * absence of this gate as the path by which Track 3 drifts could
 * re-appear silently.
 *
 * The validator-aware buckets are:
 *   - `KEY_SPECS` (src/config/general-settings.ts): scalar settings
 *     consumed by `writeGeneralSettings`.
 *   - `src/wakeup/settings.ts`: the four `wakeUp.*` keys validated
 *     by the wake-up settings module.
 *   - Complex object/array keys (`models`, `phases`, `pipelines`):
 *     validated by their respective domain modules at load time.
 *   - `backend.runner`: a closed enum consumed by the runner factory.
 *
 * Adding a new `schegent.*` contribution requires either extending
 * `KEY_SPECS` or extending this test's bucket list. There is no
 * "validated nowhere" bucket — that was the bug class FR-016 closes.
 */
describe('Feature 056 Track 3 (FR-016) — every schegent.* key has a host-side validator', () => {
  it('all package.json `schegent.*` contributions map to a known validator', async () => {
    const pkg = readPackageJson();
    const allKeys = Object.keys(pkg.contributes.configuration.properties)
      .filter((k) => k.startsWith('schegent.'))
      .map((k) => k.slice('schegent.'.length));

    const generalSettings = await import('../../src/config/general-settings.js');
    const hostValidatedKeys = generalSettings.ALLOWED_KEYS;

    const wakeUpKeys = new Set<string>([
      'wakeUp.enabled',
      'wakeUp.schedulerType',
      'wakeUp.chronologicalTime',
      'wakeUp.periodicInterval',
      'wakeUp.model'
    ]);
    const complexObjectKeys = new Set<string>(['models', 'phases', 'pipelines']);
    const backendRunnerKey = new Set<string>(['backend.runner']);
    // Application-scoped CLI spawn hardening toggle. It is read once at
    // activation and intentionally not writable through the workspace-scoped
    // general-settings IPC surface.
    const cliApplicationKeys = new Set<string>(['cli.inheritEnvironment']);
    // Feature 058 — read-once-at-activation toggles. The activation guard
    // reads `schegent.multiRoot.suppressWarning` via `getConfiguration` with
    // a typed default; SETTINGS_SCHEMA + the drift-guard in
    // `validateWorkspaceSettings(config, logger, ...)` already constrain
    // the value. Not part of KEY_SPECS because it does not flow through
    // the general-settings IPC handler.
    const multiRootKeys = new Set<string>(['multiRoot.suppressWarning']);
    // Feature 059 — per-capability trust scopes. These three keys are
    // `nullable boolean` settings consumed exclusively by
    // `src/state/capability-trust-resolver.ts` via `getConfiguration().inspect()`.
    // They never flow through the general-settings IPC handler — the
    // resolver re-reads them on every call so there is no host-side
    // validator beyond the JSON schema in package.json. Not part of
    // KEY_SPECS by design (no writeGeneralSettings path).
    const trustScopeKeys = new Set<string>([
      'trust.allowCustomPhases',
      'trust.allowCustomRetryConditions',
      'trust.allowPipelineOverrides'
    ]);
    const uiKeys = new Set<string>(['ui.confirmations.enable']);

    const orphans: string[] = [];
    for (const key of allKeys) {
      const covered =
        hostValidatedKeys.has(key) ||
        wakeUpKeys.has(key) ||
        complexObjectKeys.has(key) ||
        backendRunnerKey.has(key) ||
        cliApplicationKeys.has(key) ||
        multiRootKeys.has(key) ||
        trustScopeKeys.has(key) ||
        uiKeys.has(key);
      if (!covered) orphans.push(key);
    }

    // Failure mode: a new `schegent.*` contribution shipped without a
    // host-side validator. Fix: add to `KEY_SPECS` (preferred for
    // scalars) or to the corresponding domain module (and extend the
    // bucket list above).
    expect(orphans).toEqual([]);

    // Symmetric check: every wake-up bucket entry IS actually present
    // in package.json. Catches accidental removal of a contribution
    // that the wake-up module still expects to read.
    const allPackageKeys = new Set(allKeys);
    for (const key of [...wakeUpKeys, ...complexObjectKeys, ...backendRunnerKey]) {
      expect(allPackageKeys.has(key)).toBe(true);
    }
  });

  it('every host-validated key has a matching package.json contribution', async () => {
    // The orphan-check above is uni-directional: it catches a new
    // package.json key without a host validator. The mirror failure
    // mode — a host validator entry with no Settings UI surface —
    // would silently let a setting be writable through the IPC
    // boundary but invisible (and undocumented) to the operator.
    // This check closes the symmetry.
    const pkg = readPackageJson();
    const packageKeys = new Set(
      Object.keys(pkg.contributes.configuration.properties)
        .filter((k) => k.startsWith('schegent.'))
        .map((k) => k.slice('schegent.'.length))
    );

    const generalSettings = await import('../../src/config/general-settings.js');
    const hostKeys = Array.from(generalSettings.ALLOWED_KEYS);

    // Intentionally-internal keys: validated by the host but
    // deliberately NOT exposed in the Settings UI. Adding to this
    // allowlist requires a load-bearing reason (e.g. v1-frozen
    // single-queue invariant from CLAUDE.md hard rule 030).
    //
    //   - `queue.defaultQueueId`: the single-queue invariant pins
    //     this to `'default'` (CLAUDE.md hard rule 030). Surfacing
    //     it in Settings would invite operator drift away from the
    //     `MAX_QUEUES = 1` contract.
    const INTENTIONALLY_INTERNAL = new Set<string>(['queue.defaultQueueId']);

    const missingFromPackage: string[] = [];
    for (const key of hostKeys) {
      if (INTENTIONALLY_INTERNAL.has(key)) continue;
      if (!packageKeys.has(key)) missingFromPackage.push(key);
    }

    // Failure mode: a host validator entry without a package.json
    // contribution. Fix: add the contribution, or — if the key MUST
    // stay internal — add it to `INTENTIONALLY_INTERNAL` above with
    // a comment explaining why.
    expect(missingFromPackage).toEqual([]);
  });
});
