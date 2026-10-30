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
    // FR-R4-F04 (T26) — the base states its transport mode explicitly. A stored `inherit` follows the raw
    // mode, so changing the raw mode alone would also change the effective transport mode and name two
    // fields; an explicit `errors-only` keeps this case about one field at a time.
    const base: PrivacyProfileSettings = {
      ...privacyProfile('diagnostic').settings,
      transportCaptureMode: 'errors-only'
    };
    const mutations: ReadonlyArray<[keyof PrivacyProfileSettings, Partial<PrivacyProfileSettings>]> = [
      ['loggingVerbose', { loggingVerbose: true }],
      ['rawTranscriptMode', { rawTranscriptMode: 'always' }],
      ['sessionRetentionMaxAgeDays', { sessionRetentionMaxAgeDays: 7 }],
      ['sessionRetentionMaxBytes', { sessionRetentionMaxBytes: 1234567 }],
      ['transportCaptureMode', { transportCaptureMode: 'on' }]
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
    //
    // FR-R4-F04 (T26) — the fifth field is `off`, which is neither diagnostic's effective mode nor
    // forensic's, so it adds one difference to each and the tie stands.
    const settings: PrivacyProfileSettings = {
      loggingVerbose: true,
      rawTranscriptMode: 'always',
      sessionRetentionMaxAgeDays: privacyProfile('diagnostic').settings.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: privacyProfile('diagnostic').settings.sessionRetentionMaxBytes,
      transportCaptureMode: 'off'
    };
    const detected = detectPrivacyProfile(settings);
    expect(detected.kind).toBe('custom');
    if (detected.kind !== 'custom') return;
    expect(detected.nearest).toBe('diagnostic');
    expect(detected.differs).toEqual(['loggingVerbose', 'rawTranscriptMode', 'transportCaptureMode']);
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

// FR-R4-F04 (feature 251, contract T26; FR-002, FR-009) — every profile states and sets the transport mode.
//
// Transport is a fifth retained-evidence setting. Each profile writes it (`ephemeral` off, `diagnostic`
// the default `inherit`, `forensic` on), detection compares the EFFECTIVE mode so a workspace that never
// touched the setting keeps the profile it had, and every profile says what transport still holds: the
// residual is built from the transport policy's constants, never typed here.
describe('privacy profiles set and state the transport mode (FR-R4-F04, T26)', () => {
  const TRANSPORT_VALUES = { ephemeral: 'off', diagnostic: 'inherit', forensic: 'on' } as const;

  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)('%s writes five keys, with its transport mode', (name) => {
    const settings = privacyProfile(name).settings;
    expect(Object.keys(settings).sort()).toEqual([
      'loggingVerbose',
      'rawTranscriptMode',
      'sessionRetentionMaxAgeDays',
      'sessionRetentionMaxBytes',
      'transportCaptureMode'
    ]);
    expect(settings.transportCaptureMode).toBe(TRANSPORT_VALUES[name]);
  });

  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)(
    'detects a legacy settings object with no transport mode as %s, as before',
    (name) => {
      const { transportCaptureMode: _written, ...legacy } = privacyProfile(name).settings;
      void _written;
      expect(detectPrivacyProfile(legacy as unknown as PrivacyProfileSettings)).toEqual({ kind: 'profile', name });
    }
  );

  it('compares the effective mode, so an explicit mode equal to what inherit resolves to is the same profile', () => {
    const diagnostic = privacyProfile('diagnostic').settings;
    expect(detectPrivacyProfile({ ...diagnostic, transportCaptureMode: 'errors-only' })).toEqual({
      kind: 'profile',
      name: 'diagnostic'
    });
    // The control: an explicit mode that resolves differently is a difference, named.
    const detected = detectPrivacyProfile({ ...diagnostic, transportCaptureMode: 'on' });
    expect(detected).toEqual({ kind: 'custom', nearest: 'diagnostic', differs: ['transportCaptureMode'] });
  });

  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)('%s lists the transport residual', (name) => {
    const residual = privacyProfile(name).residual.join('\n');
    expect(residual).toContain('secret patterns redacted; otherwise CLI content as sent');
    expect(residual).toMatch(/transport/i);
    expect(residual).toMatch(/5 MiB per Run/);
    expect(residual).toMatch(/20 MiB/);
  });

  it("says on ephemeral's own line that its transport mode is off", () => {
    expect(privacyProfile('ephemeral').residual[0]).toMatch(/transport mode is `off`/i);
  });
});

// FR-R4-F04 (feature 251, contract T26; FR-014, D8) — the checkpoint residual names the one remedy and its
// scope. Deleting a Run's evidence now removes that Run's private checkpoint, but only for a Run that has
// finished (an active Run's deletion is refused) and whose evidence is in this workspace (a Run with no
// workspace evidence is refused as having none), and a residual that promised more would be the euphemism
// FR-002a forbids.
describe('privacy profiles state how to remove a checkpoint, and its scope (FR-R4-F04, D8)', () => {
  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)('%s names Run evidence deletion and its scope', (name) => {
    const checkpoint = privacyProfile(name).residual.find((line) => /^Recovery checkpoints/.test(line));
    expect(checkpoint, `${name} has a checkpoint residual`).toBeDefined();
    expect(checkpoint).toContain("To remove a Run's checkpoint, delete that Run's evidence");
    expect(checkpoint).toContain('Runs that have finished and whose evidence is in this workspace');
    // The control: the fixed bound it already stated is still there, so the sentence was added, not swapped in.
    expect(checkpoint).toMatch(/14 days and 256 MiB/);
  });
});

// FR-R4-F04 (feature 251, contract T26; FR-038) — Claude Code's egress is a fact of its own. No local
// capture setting changes what the CLI sends to the model vendor, and Schegent making no network call of
// its own does not keep that content on the machine. A profile that stated only what Schegent keeps would
// read as "nothing leaves", which is the euphemism FR-002a forbids, so every profile says it, once.
describe('privacy profiles state the egress residual (FR-R4-F04, FR-038)', () => {
  const EGRESS = /^Claude Code sends repository content and prompts to the model vendor/;

  it.each(['ephemeral', 'diagnostic', 'forensic'] as const)('%s says Claude Code sends content to the model vendor, once', (name) => {
    const lines = privacyProfile(name).residual.filter((line) => EGRESS.test(line));
    expect(lines, `${name} has one egress residual`).toHaveLength(1);
    const egress = lines[0]!;
    expect(egress).toMatch(/whatever (Schegent's )?local capture settings/i);
    expect(egress).toMatch(/no network call of its own/i);
    expect(egress).toMatch(/does not keep (that )?content on the machine/i);
  });

  it('is in every profile that exists, so a fourth cannot omit it', () => {
    for (const profile of privacyProfiles()) {
      expect(profile.residual.some((line) => EGRESS.test(line)), profile.name).toBe(true);
    }
  });
});
