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
 *   - `queue.globalConcurrencyCap.maximum` was `5`; v1 only shipped
 *     single-active-run semantics so it was pinned to `1`. Feature 092
 *     (T039a, FR-026/FR-027) supplied the lock split that pin was waiting
 *     for and re-aimed it at `[1, 20]` with a default of `3`. The guard is
 *     re-aimed, not deleted: an unpinned range is how the maximum drifted
 *     to `5` in the first place.
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
  it('keeps legacy loopable phase settings schema-valid without requiring the field', () => {
    const pkg = readPackageJson();
    const phases = pkg.contributes.configuration.properties['schegent.phases'] as unknown as {
      items: {
        required: readonly string[];
        properties: Record<string, { type?: string }>;
      };
    };

    expect(phases.items.properties.loopable?.type).toBe('boolean');
    expect(phases.items.required).not.toContain('loopable');
  });

  it('package.json default pipeline id matches the host KEY_SPECS default', () => {
    const pkg = readPackageJson();
    const contrib = pkg.contributes.configuration.properties['schegent.defaultPipelineId'];
    expect(contrib).toBeDefined();
    // Feature 098 (T046/T047/T048, FR-033) — the shared default is unset. It
    // named the built-in Pipeline; the built-in layer is empty, so all four
    // declarations now ship the empty string and this gate keeps them together.
    expect(contrib.default).toBe('');
  });

  it('package.json retry.maxAttempts has maximum 5 (effective cap)', () => {
    const pkg = readPackageJson();
    const contrib = pkg.contributes.configuration.properties['schegent.retry.maxAttempts'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(5);
    expect(contrib.minimum).toBe(1);
    expect(contrib.maximum).toBe(5);
  });

  // Feature 098 (REL-02) — the RANGE stays [1, 20]; only the DEFAULT moves to
  // 1. Concurrent Runs share one working tree, and `RunCheckpointService`
  // declines to snapshot above one in-flight Run precisely because a
  // `git diff HEAD` of a shared tree cannot be attributed to a single Run.
  // With a default of 3 that decline was the out-of-the-box behaviour: every
  // fresh install ran Git-capable phases with no restorable checkpoint and
  // nothing in the UI saying so. Defaulting to 1 makes checkpoints work by
  // default and turns parallelism into an informed opt-in. Raising it back is
  // gated on per-run worktree isolation, not on this line.
  it('package.json queue.globalConcurrencyCap is pinned to [1, 20] with default 1', () => {
    const pkg = readPackageJson();
    const contrib =
      pkg.contributes.configuration.properties['schegent.queue.globalConcurrencyCap'];
    expect(contrib).toBeDefined();
    expect(contrib.default).toBe(1);
    expect(contrib.minimum).toBe(1);
    expect(contrib.maximum).toBe(20);
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
    expect(settings.defaultPipelineId).toBe('');
    expect(settings.retryMaxAttempts).toBe(5);
    // Feature 092 (T054/T055/T055a, FR-026/FR-027) — the ceiling's default
    // moved from 1 to 3 when the lock split made concurrency representable.
    // Feature 098 (REL-02) — and back to 1: concurrent Runs share one
    // working tree, so recovery checkpoints are declined above one in-flight
    // Run. The RANGE is still [1, 20]; only the default moved.
    expect(settings.queueGlobalConcurrencyCap).toBe(1);
    expect(settings.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(settings.runtimeLogMaxGenerations).toBe(3);
  });
});

/**
 * Feature 094 (T030, FR-017, SC-012) — derive the expected cap, do not restate
 * it.
 *
 * Until 2026-08-15 the two expectations below read `toBe(1)`, eleven lines
 * under an expectation in this same file asserting the host reader was `3`.
 * This file's own header says the manifest, the host validator and the idle
 * projections must agree, and names this very setting as one of the drifts it
 * was written to fix — yet it recorded the drift instead of failing on it,
 * because every expected value in it was a hand-copied literal. A restated
 * number is a place a wrong value can be written down and look deliberate; it
 * makes the guard agree with whatever it was last edited to agree with.
 *
 * The idle projections exist to mirror what an operator would see before any
 * configuration is read, so the manifest's contributed `default` is the thing
 * they must equal. Reading it here means the next raise of the cap needs one
 * edit, in `package.json`, and this test follows.
 */
function manifestDefaultFor(settingKey: string): number {
  const pkg = readPackageJson();
  const contrib = pkg.contributes.configuration.properties[settingKey];
  expect(contrib).toBeDefined();
  expect(typeof contrib.default).toBe('number');
  return contrib.default as number;
}

describe('Feature 056 Track 3 — webview idle snapshot agrees with host defaults', () => {
  it('host IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../src/ui/sidebar/snapshot.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.queueGlobalConcurrencyCap).toBe(
      manifestDefaultFor('schegent.queue.globalConcurrencyCap')
    );
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxGenerations).toBe(3);
  });

  it('webview IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.queueGlobalConcurrencyCap).toBe(
      manifestDefaultFor('schegent.queue.globalConcurrencyCap')
    );
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

    // Catalog layers validated per row by their own resolver rather than by
    // the general-settings IPC handler. Feature 083 adds `workflows`, which
    // `src/config/workflow-catalog.ts` resolves and defect-annotates.
    const complexObjectKeys = new Set<string>(['models', 'phases', 'pipelines', 'workflows']);
    const backendRunnerKey = new Set<string>([
      'backend.runner',
      'backend.probeTimeoutSeconds'
    ]);
    // Application-scoped CLI spawn hardening toggle. It is read once at
    // activation and intentionally not writable through the workspace-scoped
    // general-settings IPC surface.
    // Feature 074 — `agy.path` is the Agy CLI binary path, same pattern as
    // `cli.path` (application-scoped, read once at activation).
    const cliApplicationKeys = new Set<string>([
      'cli.inheritEnvironment',
      'cli.environmentMode',
      'cli.environmentAllowlist',
      'codex.path',
      'agy.path'
    ]);
    // Feature 058 — read-once-at-activation toggles. The activation guard
    // reads `schegent.multiRoot.suppressWarning` via `getConfiguration` with
    // a typed default; SETTINGS_SCHEMA + the drift-guard in
    // `validateWorkspaceSettings(config, logger, ...)` already constrain
    // the value. Not part of KEY_SPECS because it does not flow through
    // the general-settings IPC handler.
    const multiRootKeys = new Set<string>(['multiRoot.suppressWarning']);
    // Features 059 and 083 — per-capability trust scopes. These keys are
    // `nullable boolean` settings consumed exclusively by
    // `src/state/capability-trust-resolver.ts` via `getConfiguration().inspect()`.
    // They never flow through the general-settings IPC handler — the
    // resolver re-reads them on every call so there is no host-side
    // validator beyond the JSON schema in package.json. Not part of
    // KEY_SPECS by design (no writeGeneralSettings path).
    const trustScopeKeys = new Set<string>([
      'trust.allowCustomPhases',
      'trust.allowCustomRetryConditions',
      'trust.allowPipelineOverrides',
      'trust.allowWorkflowOverrides'
    ]);
    const uiKeys = new Set<string>(['ui.confirmations.enable']);

    const orphans: string[] = [];
    for (const key of allKeys) {
      const covered =
        hostValidatedKeys.has(key) ||
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

    // Symmetric check: every bucket entry IS actually present in
    // package.json. Catches accidental removal of a contribution that a
    // domain module still expects to read.
    const allPackageKeys = new Set(allKeys);
    for (const key of [...complexObjectKeys, ...backendRunnerKey]) {
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
