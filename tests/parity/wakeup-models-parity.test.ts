// Feature 031 — wake-up model registry host/webview parity guard.
//
// `WAKEUP_SUPPORTED_MODELS` in `src/wakeup/settings.ts` is the single
// source of truth for the closed Claude-model registry the Wake-up
// Settings dropdown offers. It is mirrored, by hand, in three other
// places:
//
//   1. the webview bundle (webview-ui/src/lib/snapshot-types.ts) — the
//      dropdown renders from this copy because the bundle cannot import
//      host source at runtime;
//   2. the typed settings schema (src/config/settings-schema.ts) — the
//      `schegent.wakeUp.model` enum, prefixed with the `runner-default`
//      sentinel;
//   3. the VS Code contribution (package.json) — the same enum.
//
// The GENERATED contracts (boundary-contracts.ts, *.schema.json, the
// Rust mirror) are derived from the host list by
// `scripts/generate-contract-schemas.mjs`, so they cannot drift. The
// three hand-maintained copies above can — and did: `claude-opus-4-8`
// was once added to the host registry (and to #2/#3) but not to the
// webview mirror, silently dropping it from the dropdown and leaving
// `WakeupModelSelector.test.ts` red on a clean checkout. The existing
// `settings-schema-parity.test.ts` did not catch it because that guard
// only compares #2 against #3 — both can agree with each other while
// both drift from the host registry.
//
// This guard ties all three hand-maintained copies back to the host
// source of truth so that class of drift fails fast.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  WAKEUP_SUPPORTED_MODELS as HOST_WAKEUP_SUPPORTED_MODELS,
  RUNNER_DEFAULT_MODEL
} from '../../src/wakeup/settings';
import { SETTINGS_SCHEMA } from '../../src/config/settings-schema';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WAKEUP_MODEL_KEY = 'schegent.wakeUp.model';

// The two enum surfaces carry the sentinel first, then the registry in
// order. The webview mirror carries only the registry (the sentinel is
// a separate `RUNNER_DEFAULT_MODEL` export there, matching the host).
const EXPECTED_ENUM: readonly string[] = [
  RUNNER_DEFAULT_MODEL,
  ...HOST_WAKEUP_SUPPORTED_MODELS
];

function readPackageJsonWakeUpModelEnum(): readonly string[] | undefined {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as {
    contributes?: {
      configuration?: {
        properties?: Record<string, { enum?: readonly string[] }>;
      };
    };
  };
  return parsed.contributes?.configuration?.properties?.[WAKEUP_MODEL_KEY]?.enum;
}

describe('Feature 031 — wake-up model registry host/webview parity', () => {
  it('webview snapshot-types mirror matches the host registry exactly (order + members)', async () => {
    const webview = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect([...webview.WAKEUP_SUPPORTED_MODELS]).toEqual([
      ...HOST_WAKEUP_SUPPORTED_MODELS
    ]);
  });

  it('webview runner-default sentinel matches the host sentinel', async () => {
    const webview = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(webview.RUNNER_DEFAULT_MODEL).toBe(RUNNER_DEFAULT_MODEL);
  });

  it('settings-schema enum equals [runner-default, ...host registry]', () => {
    const entry = SETTINGS_SCHEMA[WAKEUP_MODEL_KEY];
    expect(entry, `missing schema entry for ${WAKEUP_MODEL_KEY}`).toBeDefined();
    expect(entry.enum).toEqual(EXPECTED_ENUM);
  });

  it('package.json enum equals [runner-default, ...host registry]', () => {
    expect(readPackageJsonWakeUpModelEnum()).toEqual(EXPECTED_ENUM);
  });
});
