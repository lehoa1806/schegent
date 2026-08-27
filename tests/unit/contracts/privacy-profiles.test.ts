// FR-R3-127 (T008) — the three profiles, and what `custom` has to be able to say.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  detectPrivacyProfile,
  privacyProfile,
  privacyProfiles,
  type PrivacyProfileSettings
} from '../../../src/contracts/privacy-profiles';

const MANIFEST = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};
/**
 * The manifest's declared default for one key.
 *
 * Throws rather than returning `undefined` for an absent key: this helper exists to
 * hold `diagnostic` against the shipped defaults, and a missing key silently
 * comparing `undefined` to `undefined` would make that assertion pass for the wrong
 * reason. Under `noUncheckedIndexedAccess` the check is also what keeps this file
 * off the ratchet.
 */
const manifestDefault = (key: string): unknown => {
  const properties: Readonly<Record<string, { default?: unknown } | undefined>> =
    MANIFEST.contributes.configuration.properties;
  const entry = properties[key];
  if (entry === undefined) throw new Error(`manifest declares no setting '${key}'`);
  return entry.default;
};

describe('privacy profiles (FR-R3-127)', () => {
  it('declares exactly three, each with an audience and a residual', () => {
    const profiles = privacyProfiles();
    expect(profiles.map((p) => p.name)).toEqual(['ephemeral', 'diagnostic', 'forensic']);
    for (const profile of profiles) {
      expect(profile.audience.length, `${profile.name} audience`).toBeGreaterThan(40);
      // FR-002a — a profile that says nothing about what it leaves alone is the
      // euphemism this feature exists to remove.
      expect(profile.residual.length, `${profile.name} residual`).toBeGreaterThan(3);
    }
  });

  it('every profile names the fixed checkpoint bound it does not change', () => {
    // The most likely misreading of "ephemeral" is that it clears everything. It
    // cannot: FR-R3-012 made the checkpoint bound a constant on purpose.
    for (const profile of privacyProfiles()) {
      expect(profile.residual.join(' '), profile.name).toMatch(/checkpoint/i);
      expect(profile.residual.join(' '), profile.name).toMatch(/14 days/);
    }
  });

  it('every profile warns that .gitignore does not stop backup or sync tooling', () => {
    // The audit's own edge case, and the reason an operator picks `ephemeral`.
    for (const profile of privacyProfiles()) {
      expect(profile.residual.join(' '), profile.name).toMatch(/backup|sync/i);
    }
  });

  it('diagnostic IS the shipped manifest defaults — read, not restated (SC-002)', () => {
    // If a default moves, THIS is what fails, which is the point of deriving it.
    const diagnostic = privacyProfile('diagnostic').settings;
    expect(diagnostic.loggingVerbose).toBe(manifestDefault('schegent.logging.verbose'));
    expect(diagnostic.rawTranscriptMode).toBe(manifestDefault('schegent.logging.rawTranscriptMode'));
    expect(diagnostic.sessionRetentionMaxAgeDays).toBe(
      manifestDefault('schegent.logging.sessionRetentionMaxAgeDays')
    );
    expect(diagnostic.sessionRetentionMaxBytes).toBe(
      manifestDefault('schegent.logging.sessionRetentionMaxBytes')
    );
  });

  it('ephemeral turns raw capture OFF, not down', () => {
    // `errors-only` still retains an unredacted transcript for every failed Run.
    // A profile called ephemeral that did that would be a euphemism.
    expect(privacyProfile('ephemeral').settings.rawTranscriptMode).toBe('off');
    expect(privacyProfile('ephemeral').settings.loggingVerbose).toBe(false);
  });

  it('forensic carries an explicit warning, not just larger numbers', () => {
    const forensic = privacyProfile('forensic');
    expect(forensic.settings.rawTranscriptMode).toBe('always');
    expect(forensic.residual[0]).toMatch(/WARNING/);
  });

  it('round-trips: applying a profile then detecting yields its own name (SC-001)', () => {
    for (const profile of privacyProfiles()) {
      const detected = detectPrivacyProfile(profile.settings);
      expect(detected, profile.name).toEqual({ kind: 'profile', name: profile.name });
    }
  });

  it('one differing setting yields custom and NAMES that setting (SC-003)', () => {
    // Asserted per field rather than once: a detection that reported `custom`
    // without saying which field would leave the operator no better off.
    const base = privacyProfile('diagnostic').settings;
    const mutations: ReadonlyArray<[keyof PrivacyProfileSettings, Partial<PrivacyProfileSettings>]> = [
      ['loggingVerbose', { loggingVerbose: true }],
      ['rawTranscriptMode', { rawTranscriptMode: 'always' }],
      ['sessionRetentionMaxAgeDays', { sessionRetentionMaxAgeDays: 7 }],
      ['sessionRetentionMaxBytes', { sessionRetentionMaxBytes: 1234567 }]
    ];
    for (const [field, patch] of mutations) {
      const detected = detectPrivacyProfile({ ...base, ...patch });
      expect(detected.kind, field).toBe('custom');
      if (detected.kind !== 'custom') continue;
      expect(detected.differs, field).toEqual([field]);
      expect(detected.nearest, field).toBe('diagnostic');
    }
  });

  it('breaks a nearest-profile tie toward diagnostic', () => {
    // Two fields from `diagnostic` and two from `forensic`: without the tie rule
    // the reported nearest would depend on table order.
    const settings: PrivacyProfileSettings = {
      loggingVerbose: true,
      rawTranscriptMode: 'always',
      sessionRetentionMaxAgeDays: privacyProfile('diagnostic').settings.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: privacyProfile('diagnostic').settings.sessionRetentionMaxBytes
    };
    const detected = detectPrivacyProfile(settings);
    expect(detected.kind).toBe('custom');
    if (detected.kind !== 'custom') return;
    expect(detected.nearest).toBe('diagnostic');
    expect(detected.differs).toEqual(['loggingVerbose', 'rawTranscriptMode']);
  });

  it('no profile is presented as a permission boundary (FR-007)', () => {
    for (const profile of privacyProfiles()) {
      expect(profile.residual.join(' '), profile.name).toMatch(/not a permission boundary/i);
    }
  });
});
