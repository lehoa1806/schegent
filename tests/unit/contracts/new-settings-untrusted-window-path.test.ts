// FR-R3-144 (T047, G-4) — the three settings this feature added reach an
// untrusted window down a path that already existed, and not down a new one.
//
// WHY THIS IS WORTH A TEST OF ITS OWN. `FR-R3-136` decided what a workspace may
// say about Schegent's settings while the operator has declined to trust it, and
// it decided it ONCE: every workspace-settable property carries a sensitivity
// class, the manifest's `restrictedConfigurations` is derived from those classes,
// and the properties that decide which binary runs are held out of a workspace's
// reach entirely by `application` scope. A feature that adds settings can honour
// that decision or quietly invent a second mechanism beside it — a bespoke check
// in a handler, a hardcoded key list, a webview that disables its own control —
// and the second mechanism is the one that goes stale, because the parity gate
// does not know it exists.
//
// So each assertion below is a COMPARISON against a setting that predates this
// feature and already travels the intended path. Nothing here restates a class
// name or a scope: the expected value is read from the reference row, so a policy
// change moves both sides together and this file keeps testing the same claim.
//
// `schegent.retry.maxAttempts` is the reference for the two spend bounds — the
// tasks list names it, and it is the same kind of thing: a number that tunes a run
// the untrusted window will never start. `schegent.cli.path` is the reference for
// the backend selector, which is not workspace-settable at all.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONFIGURATION_SENSITIVITY,
  EXECUTABLE_AUTHORITY_PROPERTIES,
  WORKSPACE_SETTABLE_SCOPES,
  derivedRestrictedConfigurations,
  requireSensitivity
} from '../../../src/contracts/configuration-trust-dispositions';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface Manifest {
  readonly contributes: {
    readonly configuration: {
      readonly properties: Record<string, { readonly scope?: string } | undefined>;
    };
  };
}

const properties = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as Manifest
).contributes.configuration.properties;

/** VS Code treats an absent `scope` as `window`, which a workspace can set. */
function scopeOf(key: string): string {
  return properties[key]?.scope ?? 'window';
}

/** The reference row for a run-tuning number a workspace may set. */
const RUN_SHAPE_REFERENCE = 'schegent.retry.maxAttempts';
/** The reference row for a setting that decides which binary runs. */
const EXECUTABLE_REFERENCE = 'schegent.cli.path';

/** The two per-run bounds FR-R3-144 added. Workspace-settable, like the reference. */
const SPEND_KEYS = ['schegent.spend.maxUsdPerRun', 'schegent.spend.maxTokensPerRun'] as const;
/** The selector FR-R3-144 added. Decides which binary runs, like the reference. */
const RUNNER_KEY = 'schegent.backend.runner';

describe('FR-R3-144 T047 — the new settings travel an existing untrusted-window path', () => {
  it('the references are still what this file assumes, so a comparison means something', () => {
    // Every assertion below is "the same as the reference". If the reference ever
    // stopped being classified, workspace-settable and unrestricted, those
    // assertions would pass by matching nothing.
    expect(Object.keys(properties)).toContain(RUN_SHAPE_REFERENCE);
    expect(WORKSPACE_SETTABLE_SCOPES.has(scopeOf(RUN_SHAPE_REFERENCE))).toBe(true);
    expect(CONFIGURATION_SENSITIVITY).toHaveProperty(RUN_SHAPE_REFERENCE);
    expect(
      derivedRestrictedConfigurations(),
      'the reference is unrestricted; a restricted reference would invert every check below'
    ).not.toContain(RUN_SHAPE_REFERENCE);

    expect(Object.keys(properties)).toContain(EXECUTABLE_REFERENCE);
    expect(scopeOf(EXECUTABLE_REFERENCE)).toBe('application');
    expect(EXECUTABLE_AUTHORITY_PROPERTIES).toContain(EXECUTABLE_REFERENCE);
  });

  it('classifies both spend bounds exactly as it classifies the retry cap', () => {
    const reference = requireSensitivity(RUN_SHAPE_REFERENCE);
    for (const key of SPEND_KEYS) {
      expect(Object.keys(properties), `${key} must exist in the manifest`).toContain(key);
      // Read, never restated: if the reference is reclassified, so is the
      // expectation, and this test goes on asserting "the same as" rather than
      // pinning a class name that has moved.
      expect(
        requireSensitivity(key).sensitivity,
        `${key} bounds a run the same way ${RUN_SHAPE_REFERENCE} does, and a different ` +
          'class here would be a second opinion about the same window'
      ).toBe(reference.sensitivity);
      expect(requireSensitivity(key).reason.length).toBeGreaterThan(0);
    }
  });

  it('restricts both spend bounds exactly as it restricts the retry cap', () => {
    // The class is the input; this is the OUTPUT, and it is asserted separately
    // because a derivation that stopped consulting the class would still leave the
    // classes matching. Membership is compared, not asserted absolutely — the two
    // travel together whichever way the policy goes.
    const restricted = derivedRestrictedConfigurations();
    const referenceRestricted = restricted.includes(RUN_SHAPE_REFERENCE);
    for (const key of SPEND_KEYS) {
      expect(restricted.includes(key), `${key} must be restricted iff the retry cap is`).toBe(
        referenceRestricted
      );
    }
  });

  it('leaves both spend bounds settable by a workspace, like the retry cap', () => {
    for (const key of SPEND_KEYS) {
      expect(scopeOf(key)).toBe(scopeOf(RUN_SHAPE_REFERENCE));
    }
  });

  it('holds the backend selector out of a workspace’s reach the way the CLI path is', () => {
    // The stronger of the two existing paths, and deliberately not the weaker one:
    // `application` scope means a workspace cannot set the value at all, in a
    // trusted window as well as an untrusted one. Which backend runs is exactly the
    // decision a repository must not get a vote on.
    expect(scopeOf(RUNNER_KEY)).toBe(scopeOf(EXECUTABLE_REFERENCE));
    expect(EXECUTABLE_AUTHORITY_PROPERTIES).toContain(RUNNER_KEY);
    expect(
      CONFIGURATION_SENSITIVITY,
      'and therefore NOT in the sensitivity map — a row there would claim a workspace ' +
        'can set it, and the parity gate reads that map as the list of what a ' +
        'workspace can say'
    ).not.toHaveProperty(RUNNER_KEY);
    expect(derivedRestrictedConfigurations()).not.toContain(RUNNER_KEY);
  });

  it('adds no fourth mechanism: every new key is on exactly one of the two paths', () => {
    // The failure this catches is a key that is neither classified nor
    // application-scoped — settable by an untrusted workspace with nothing
    // recording an opinion, which is the state all twenty-eight properties were in
    // before FR-R3-136.
    for (const key of [...SPEND_KEYS, RUNNER_KEY]) {
      const classified = Object.prototype.hasOwnProperty.call(CONFIGURATION_SENSITIVITY, key);
      const withheld = EXECUTABLE_AUTHORITY_PROPERTIES.includes(key);
      expect(
        [classified, withheld].filter(Boolean),
        `${key} must be on exactly one path: classified, or held out by application scope`
      ).toHaveLength(1);
    }
  });
});
