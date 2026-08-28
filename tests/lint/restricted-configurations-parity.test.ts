// FR-R3-136 (FR-013, FR-014, FR-015, T1526c) — the manifest's
// `restrictedConfigurations` and the sensitivity classes are the same list, and
// the nine executable-authority settings are still out of the workspace's reach.
//
// FOUR DIRECTIONS, because a one-directional check is how the gap this feature
// closes came to exist. `capabilities.untrustedWorkspaces` had a paragraph about
// commands and no settings key at all, and nothing failed — the manifest was
// self-consistent, it just did not mention twenty-eight properties.
//
//   1. Every workspace-settable property has a sensitivity disposition. A new
//      setting arrives unclassified and this fails; the property cannot slip in
//      on the strength of nobody having an opinion about it.
//   2. Every restricted-class property appears in the manifest list. A row
//      reclassified in the map and not regenerated fails here.
//   3. The manifest names nothing that does not exist. A renamed or deleted
//      property leaves a dead entry that reads like protection and is not.
//   4. FR-015 — each of the nine executable/backend settings is still
//      `application`-scoped. This is the direction with no counterpart in the
//      map, because those nine are deliberately absent from it: `application`
//      scope is a STRONGER guarantee than a restricted configuration, since it
//      holds in a trusted window too. What it is not is a durable one — it is one
//      word per property in `package.json`, and today nothing notices if it
//      changes. This does.
//
// THE FIFTH ASSERTION IS THE ONE THAT KEEPS THE POLICY HONEST: the counts. Twenty-
// eight classified, of which fourteen restricted, in four classes. Not because the
// numbers matter, but because every check above is a set comparison that a shrunken
// scan satisfies trivially — an empty property list passes 1, 2 and 3 at once.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONFIGURATION_SENSITIVITY,
  EXECUTABLE_AUTHORITY_PROPERTIES,
  RESTRICTED_CLASSES,
  WORKSPACE_SETTABLE_SCOPES,
  UnclassifiedConfigurationError,
  derivedRestrictedConfigurations,
  requireSensitivity,
  type SensitivityClass
} from '../../src/contracts/configuration-trust-dispositions';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface ConfigurationProperty {
  readonly scope?: string;
}

interface Manifest {
  readonly contributes: {
    // The value is declared `| undefined` because this file exists to find keys
    // the manifest does NOT declare — `scopeOf` and the `ABSENT` branch below are
    // both reads of a key that may be missing. With `noUncheckedIndexedAccess`
    // off, an unqualified value type would make those two guards read as dead
    // code while they are the checks doing the work.
    readonly configuration: {
      readonly properties: Record<string, ConfigurationProperty | undefined>;
    };
  };
  readonly capabilities?: {
    readonly untrustedWorkspaces?: {
      readonly supported?: string;
      readonly restrictedConfigurations?: readonly string[];
    };
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')
) as Manifest;

const properties = manifest.contributes.configuration.properties;

/** VS Code treats an absent `scope` as `window`, which is workspace-settable. */
function scopeOf(key: string): string {
  return properties[key]?.scope ?? 'window';
}

function workspaceSettableKeys(): readonly string[] {
  return Object.keys(properties)
    .filter((key) => WORKSPACE_SETTABLE_SCOPES.has(scopeOf(key)))
    .sort();
}

function manifestRestricted(): readonly string[] {
  return [...(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [])].sort();
}

describe('restrictedConfigurations parity (FR-R3-136 T1526c)', () => {
  it('classifies every workspace-settable property', () => {
    const unclassified = workspaceSettableKeys().filter(
      (key) => !(key in CONFIGURATION_SENSITIVITY)
    );
    expect(
      unclassified,
      'These properties are workspace-settable and have no sensitivity disposition. ' +
        'A setting a repository can write must have a recorded opinion about whether ' +
        'it may speak while the folder is untrusted:\n' +
        unclassified.map((key) => `  ${key} (scope: ${scopeOf(key)})`).join('\n')
    ).toEqual([]);
  });

  it('restricts exactly the properties whose class is restricted', () => {
    expect(manifestRestricted()).toEqual([...derivedRestrictedConfigurations()]);
  });

  it('names no property that does not exist', () => {
    const ghosts = manifestRestricted().filter((key) => !(key in properties));
    expect(
      ghosts,
      'restrictedConfigurations names properties that are not in ' +
        'contributes.configuration. A dead entry reads like protection and is ' +
        `not:\n${ghosts.join('\n')}`
    ).toEqual([]);
  });

  it('classifies nothing that a workspace cannot set', () => {
    // The mirror of direction 1, and the reason it is separate: a row for an
    // `application`-scoped property would be a disposition that can never apply,
    // and it would make the count assertion below agree with a policy that is
    // partly fiction.
    const unreachable = Object.keys(CONFIGURATION_SENSITIVITY).filter(
      (key) => !(key in properties) || !WORKSPACE_SETTABLE_SCOPES.has(scopeOf(key))
    );
    expect(
      unreachable,
      'These rows classify a property that is absent or not workspace-settable:\n' +
        unreachable.map((key) => `  ${key} (scope: ${properties[key] ? scopeOf(key) : 'ABSENT'})`).join('\n')
    ).toEqual([]);
  });

  it('FR-015 — every executable-authority setting is still application-scoped', () => {
    const escaped: string[] = [];
    for (const key of EXECUTABLE_AUTHORITY_PROPERTIES) {
      if (!(key in properties)) {
        escaped.push(`${key}: absent from contributes.configuration`);
        continue;
      }
      if (scopeOf(key) !== 'application') {
        escaped.push(`${key}: scope is now "${scopeOf(key)}"`);
      }
    }
    expect(
      escaped,
      'These settings decide WHICH BINARY runs and WHAT ENVIRONMENT it runs in, and ' +
        '`application` scope is what keeps a repository from naming them at all — a ' +
        'stronger guarantee than restrictedConfigurations, because it holds in a ' +
        'trusted window too. One of them has moved. Either revert the scope, or ' +
        'classify it in configuration-trust-dispositions.ts and accept that a ' +
        'repository may now set it in a trusted window:\n' +
        escaped.join('\n')
    ).toEqual([]);
  });

  it('declares limited support and a non-empty restricted list', () => {
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe('limited');
    expect(manifestRestricted().length).toBeGreaterThan(0);
  });

  // Non-vacuity. Every assertion above is a set difference, and an empty scan
  // satisfies all of them at once: no properties means nothing unclassified,
  // nothing missing and no ghosts. These pin the sizes of the sets the checks
  // run over, and the class histogram, so a policy change has to be a deliberate
  // edit here rather than a silent shift in the map.
  it('runs over the sets it claims to (counts and class histogram)', () => {
    expect(workspaceSettableKeys()).toHaveLength(28);
    expect(Object.keys(CONFIGURATION_SENSITIVITY)).toHaveLength(28);
    expect(derivedRestrictedConfigurations()).toHaveLength(14);
    expect(EXECUTABLE_AUTHORITY_PROPERTIES).toHaveLength(9);

    const histogram = new Map<SensitivityClass, number>();
    for (const entry of Object.values(CONFIGURATION_SENSITIVITY)) {
      histogram.set(entry.sensitivity, (histogram.get(entry.sensitivity) ?? 0) + 1);
    }
    expect(Object.fromEntries(histogram)).toEqual({
      capability: 2,
      'operator-signal': 4,
      evidence: 8,
      'run-shape': 14
    });
    // The classes that produce the list, stated once so a reclassification of the
    // POLICY (rather than of a property) is also a visible edit.
    expect([...RESTRICTED_CLASSES].sort()).toEqual(['capability', 'evidence', 'operator-signal']);
  });

  it('throws on an unclassified key, which is the mechanism the first check relies on', () => {
    expect(() => requireSensitivity('schegent.notAThing')).toThrow(UnclassifiedConfigurationError);
    expect(requireSensitivity('schegent.trust.allowCustomPhases').sensitivity).toBe('capability');
  });

  it('gives every row a reason a refusal could name', () => {
    const thin = Object.entries(CONFIGURATION_SENSITIVITY)
      .filter(([, entry]) => entry.reason.trim().length < 20)
      .map(([key]) => key);
    expect(
      thin,
      `These rows have no usable reason:\n${thin.join('\n')}`
    ).toEqual([]);
  });
});
