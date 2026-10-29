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

// FR-R4-F15 (feature 243, contract K5.2, K6.11; FR-016) — every profile states the failure record.
//
// A failed Run keeps a redacted, bounded record outside the session tree, and no profile turns writing
// it off (D5), so the one sentence that says so belongs in every profile's residual list: an operator
// choosing `ephemeral` reads that profile, and a list that left out a file this product still writes
// would be the euphemism FR-002a forbids. The sentence is pinned verbatim.
describe('privacy profiles state the failure record (FR-R4-F15, K6.11)', () => {
  const FAILURE_RECORD_RESIDUAL =
    'A failed Run keeps a redacted, bounded failure record in `.schegent/failure-records/` for this ' +
    "profile's session age, and at most the newest 200 records are kept. Remove does not delete it; " +
    "the Run's Delete Evidence does.";

  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)(
    '%s lists the failure record sentence, once',
    (name) => {
      const residual = privacyProfile(name).residual;
      expect(residual.filter((line) => line === FAILURE_RECORD_RESIDUAL)).toHaveLength(1);
    }
  );

  it('says it in every profile that exists, so a fourth cannot omit it', () => {
    for (const profile of privacyProfiles()) {
      expect(profile.residual, profile.name).toContain(FAILURE_RECORD_RESIDUAL);
    }
  });

  it('names failure records in the age setting\'s description and moves no default or range (K5.1, FR-016)', () => {
    const properties = MANIFEST.contributes.configuration.properties as Record<
      string,
      { default?: unknown; minimum?: unknown; maximum?: unknown; markdownDescription?: string } | undefined
    >;
    const age = properties['schegent.logging.sessionRetentionMaxAgeDays'];
    expect(age?.markdownDescription).toContain('failure records in `.schegent/failure-records/`');
    expect(age?.markdownDescription).toContain('failure records older than this are removed');
    expect(age?.markdownDescription).toContain('The append-only structured audit log is never pruned by this setting.');
    // No default or range changes (FR-016); the byte setting does not bound records and is not edited.
    expect([age?.default, age?.minimum, age?.maximum]).toEqual([30, 1, 3650]);
    expect(properties['schegent.logging.sessionRetentionMaxBytes']?.markdownDescription ?? '').not.toContain('failure record');
  });

  it('keeps the first residual line of each profile what it was', () => {
    expect(privacyProfile('ephemeral').residual[0]).toMatch(/^Raw capture is OFF/);
    expect(privacyProfile('forensic').residual[0]).toMatch(/WARNING/);
  });
});
