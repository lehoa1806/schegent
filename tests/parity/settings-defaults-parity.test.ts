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
 *     for and re-aimed it at `[1, 20]` with a default of `3`.
 *
 * This test pins those values and rejects future drift on the shared schema
 * surface.
 *
 * FR-R3-145 (T1570) — the third drift's setting is gone. `schegent.queue.
 * globalConcurrencyCap` was a configuration key nothing enforced against: the
 * cap the drain gates on lives in the workspace memento, and the two were free to
 * disagree. The key was removed rather than wired up, and the parity that
 * replaces it — host and webview idle queue settings against the store's own
 * defaults — is at the bottom of this file. The history above is left standing
 * because it is why the surviving guards are shaped the way they are.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';

// FR-R3-145 (T1570) — the store's own fallbacks, so the queue-settings parity
// below asserts what a cold workspace reports rather than a restatement of it.
import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../src/contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
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
  // Feature 099 (T496f, FR-041) — the three definition keys leave package.json
  // with the settings-backed catalog. The loopable claim was never about the
  // Settings UI: it says a phase authored before `loopable` was optional still
  // loads, and a phase without it still loads. Both arms now settle where the
  // rows are actually read, so the claim moves to the row validator and the
  // parity file keeps only what parity can still see — that the contribution
  // is gone, and no host bucket still expects it.
  it('accepts a stored phase row with or without the deprecated loopable field', async () => {
    const { resolvePhaseCatalog } = await import('../../src/config/process-catalog.js');
    const base = { id: 'legacy', name: 'Legacy', instruction: 'Do the thing.' };
    const resolution = resolvePhaseCatalog({
      rows: [{ ...base, loopable: true }, { ...base, id: 'modern' }],
      revision: 'rev-phase-loopable'
    });
    expect(resolution.records.map((record) => record.status)).toEqual(['effective', 'effective']);
    expect(resolution.effective.map((phase) => phase.phaseId)).toEqual(['legacy', 'modern']);
  });

  it('contributes none of the three definition keys any more', () => {
    const pkg = readPackageJson();
    const props = pkg.contributes.configuration.properties;
    expect(props['schegent.phases']).toBeUndefined();
    expect(props['schegent.pipelines']).toBeUndefined();
    expect(props['schegent.workflows']).toBeUndefined();
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

  // FR-R3-145 (T1570) — the `queue.globalConcurrencyCap` manifest pin that stood
  // here is gone with the property. It asserted `[1, 20]` and a default of `1`
  // against a contribution no scheduling path read; the values were right and the
  // subject was not. Its replacement — the cap's real range asserted against
  // `MAX_QUEUES`, and its real default against the store's — is at the bottom of
  // this file and in `tests/unit/contracts/validators/queue-management.test.ts`,
  // which exercises the validator that actually refuses an out-of-range cap. The
  // 098 reasoning for the default of `1` moved to `src/contracts/queue-bounds.ts`,
  // beside the constant it explains.

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
    // FR-R3-145 (T1570) — the concurrency cap is no longer read here. It was
    // never enforced against configuration: both drain predicates read the
    // workspace memento, and `readGeneralSettings` reads
    // `vscode.workspace.getConfiguration`. Asserting a configuration default for
    // it made this file agree that a number mattered which nothing consulted.
    // The cap's default is now asserted against `IDLE_QUEUE_SETTINGS` below.
    expect(settings.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(settings.runtimeLogMaxGenerations).toBe(3);
  });
});

/**
 * Feature 094 (T030, FR-017, SC-012) — derive the expected value, do not restate
 * it. The rule outlived the helper that carried it.
 *
 * Until 2026-08-15 two expectations below read `toBe(1)`, eleven lines under an
 * expectation in this same file asserting the host reader was `3`. This file's own
 * header says the manifest, the host validator and the idle projections must
 * agree, and named that very setting as one of the drifts it was written to fix —
 * yet it recorded the drift instead of failing on it, because every expected value
 * in it was a hand-copied literal. A restated number is a place a wrong value can
 * be written down and look deliberate; it makes the guard agree with whatever it
 * was last edited to agree with.
 *
 * Feature 094's answer was `manifestDefaultFor()`, reading the contributed
 * `default` out of `package.json`. FR-R3-145 (T1570) removed it with its last
 * caller: the one setting it was built for turned out to have no manifest entry
 * that anything enforced. The rule it embodied is unchanged, and the queue-settings
 * parity at the bottom of this file follows it — deriving from
 * `DEFAULT_GLOBAL_CONCURRENCY_CAP`, which is what the store actually falls back
 * to. What changed is which document is authoritative for this one value.
 */

describe('Feature 056 Track 3 — webview idle snapshot agrees with host defaults', () => {
  it('host IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../src/ui/sidebar/snapshot.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxGenerations).toBe(3);
  });

  it('webview IDLE_GENERAL_SETTINGS uses the corrected defaults', async () => {
    const mod = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(mod.IDLE_GENERAL_SETTINGS.defaultPipelineId).toBe('');
    expect(mod.IDLE_GENERAL_SETTINGS.retryMaxAttempts).toBe(5);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxBytes).toBe(5 * 1024 * 1024);
    expect(mod.IDLE_GENERAL_SETTINGS.runtimeLogMaxGenerations).toBe(3);
  });
});

/**
 * FR-R3-145 (T1570) — the same parity for the queue settings, against the store
 * that decides them.
 *
 * The two assertions this replaces derived the expected cap from
 * `package.json`'s contributed `default`, which was the right instinct for a
 * setting the manifest declares. The cap is not one: no scheduling path ever read
 * the configuration key, and it is now removed. Deriving from `MANIFEST` would
 * have left this gate reading `undefined` and passing on `undefined === undefined`
 * — a coverage gate that cannot fail, which is the subject of this item.
 *
 * `DEFAULT_GLOBAL_CONCURRENCY_CAP` and `DEFAULT_QUEUE_ID` are the store's own
 * fallbacks, so this asserts what a cold workspace actually reports and not a
 * second opinion about it.
 */
describe('FR-R3-145 — idle queue settings agree with the store defaults', () => {
  it('host IDLE_QUEUE_SETTINGS derives from the contract constants', async () => {
    const mod = await import('../../src/ui/sidebar/snapshot.js');
    expect(mod.IDLE_QUEUE_SETTINGS.globalConcurrencyCap).toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);
    expect(mod.IDLE_QUEUE_SETTINGS.defaultQueueId).toBe(DEFAULT_QUEUE_ID);
  });

  it('webview IDLE_QUEUE_SETTINGS is the same object by value', async () => {
    const host = await import('../../src/ui/sidebar/snapshot.js');
    const webview = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(webview.IDLE_QUEUE_SETTINGS).toEqual(host.IDLE_QUEUE_SETTINGS);
  });

  it('no manifest property declares the cap any more', () => {
    const pkg = readPackageJson();
    expect(
      pkg.contributes.configuration.properties['schegent.queue.globalConcurrencyCap'],
      'the configuration key was removed; a reappearance means a second store for the cap'
    ).toBeUndefined();
    expect(
      pkg.contributes.configuration.properties['schegent.queue.defaultQueueId']
    ).toBeUndefined();
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
 * Feature 099 (T496f) — `phases`, `pipelines`, and `workflows` left the
 * settings surface for the catalog store, so they are no longer parity
 * subjects here; the store's own tests own their round-trip.
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

    // Feature 099 (T496f, FR-041) — `phases`, `pipelines`, and `workflows` are
    // no longer settings at all: their rows live in the catalog store, so there
    // is no contribution left for a bucket to claim. The Model Catalog is out of
    // scope for 099 (it stays as feature 096 left it) and remains the one
    // complex object still validated per row off a settings key.
    const complexObjectKeys = new Set<string>(['models']);
    const backendRunnerKey = new Set<string>([
      'backend.runner',
      'backend.probeTimeoutSeconds',
      // FR-R3-056 — the capability posture. Read at the point a backend is
      // constructed, and deliberately NOT writable through the workspace-scoped
      // general-settings IPC surface: a workspace must not be able to grant
      // itself the right to run an unbounded agent, and a webview write path
      // would be exactly that.
      //
      // FR-R3-125 — one boolean became a list of backend ids so a grant applies to
      // the backend it names and no other. Read through
      // `resolveUncontainedGrant`, which validates entries rather than filtering
      // them and fails closed on anything that is not a list of strings — a stale
      // `true` from the removed key therefore grants nothing.
      'backend.uncontainedBackends'
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
    // Feature 099 (T492, FR-046) — `trust.allowPipelineOverrides` and
    // `trust.allowWorkflowOverrides` asked whether one layer could redefine what
    // another declares; one layer poses no such question, so both capabilities
    // and both contributions are deleted.
    const trustScopeKeys = new Set<string>([
      'trust.allowCustomPhases',
      'trust.allowCustomRetryConditions'
    ]);
    const uiKeys = new Set<string>(['ui.confirmations.enable']);
    // FR-R3-075 (feature 152) — deprecated manifest aliases. Each carries a
    // `deprecationMessage`, is hidden from the settings editor's default view,
    // and is READ-ONLY to the host (an inspect-based fallback in extension.ts
    // honours an explicit legacy value while the renamed key is unset). It is
    // never written through the IPC settings surface, so it deliberately has
    // no KEY_SPECS validator — adding one would give two keys one typed field
    // and let the unset alias's default clobber an explicit new-key value.
    const deprecatedAliasKeys = new Set<string>(['invocation.timeoutSeconds']);
    // FR-R3-112 — the per-run spend bound. Nullable numbers read at evaluation time by
    // `src/activation/run-safety-wiring.ts` through `getConfiguration()`, re-read on every
    // evaluation so an operator who sets a limit mid-run means it for that run. Deliberately NOT
    // in `KEY_SPECS`: the general-settings IPC surface is workspace-scoped and webview-writable,
    // and a webview that could raise its own spend bound is not a bound. The JSON schema in
    // `package.json` plus `SETTINGS_SCHEMA` constrain the value; the same arrangement the trust
    // scopes above use, and for the same reason.
    const spendBoundKeys = new Set<string>(['spend.maxUsdPerRun', 'spend.maxTokensPerRun']);

    const orphans: string[] = [];
    for (const key of allKeys) {
      const covered =
        hostValidatedKeys.has(key) ||
        complexObjectKeys.has(key) ||
        backendRunnerKey.has(key) ||
        cliApplicationKeys.has(key) ||
        multiRootKeys.has(key) ||
        trustScopeKeys.has(key) ||
        uiKeys.has(key) ||
        deprecatedAliasKeys.has(key) ||
        spendBoundKeys.has(key);
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
    for (const key of [...complexObjectKeys, ...backendRunnerKey, ...trustScopeKeys]) {
      expect(allPackageKeys.has(key)).toBe(true);
    }

    // The mirror of the bucket edit above: a retired key must not come back as
    // a contribution without a host validator to match it.
    for (const key of ['phases', 'pipelines', 'workflows', 'trust.allowPipelineOverrides', 'trust.allowWorkflowOverrides']) {
      expect(allPackageKeys.has(key)).toBe(false);
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

    // Non-vacuity for the walk below: an emptied host table would report nothing
    // missing, truthfully and uselessly.
    expect(hostKeys.length).toBeGreaterThan(20);

    // FR-R3-145 (T1570) — the `INTENTIONALLY_INTERNAL` set that stood here is
    // gone. It held one name, `queue.defaultQueueId`, excused on the strength of
    // a single-queue invariant that feature 092 reversed years before this was
    // read again. The key is no longer a `KEY_SPECS` payload key at all, so the
    // set excused nothing — and while it stood, the key could have returned as a
    // host-validated setting with no Settings UI surface and this gate would have
    // stayed green. Every host-validated key now has to answer for itself.
    const missingFromPackage: string[] = [];
    for (const key of hostKeys) {
      if (!packageKeys.has(key)) missingFromPackage.push(key);
    }

    // Failure mode: a host validator entry without a package.json
    // contribution — a setting writable through the IPC boundary but
    // invisible and undocumented to the operator. Fix: add the
    // contribution, or take the key out of `KEY_SPECS`.
    expect(missingFromPackage).toEqual([]);
  });
});
