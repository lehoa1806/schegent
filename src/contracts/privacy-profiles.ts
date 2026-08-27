// FR-R3-127 (FR-001, FR-002a, FR-003) — the evidence store's privacy posture as
// three named choices instead of four settings an operator has to reconcile.
//
// WHY THIS EXISTS. The repository audit of 2026-08-27 found the evidence tiers
// correctly separated and then found a CONCENTRATION: failed, paused and canceled
// Runs — "exactly where prompts and output are most likely to contain sensitive
// debugging context" — retain unredacted raw transcripts by default. Nothing about
// the mechanism is missing (`FR-R3-050`, `085`, `007`, `048`). What was missing is
// the aggregate view as a CHOICE: an operator on a shared account, a managed
// endpoint or a backup-synchronized home directory had to derive a safe
// configuration from a dozen settings and a threat-model appendix.
//
// WHY IT LIVES IN `contracts/`. `tests/lint/webview-host-import-direction.test.ts`
// pins webview -> host VALUE imports to `src/contracts/`. Both sides read this
// table — the settings tab renders the detected profile, the host documents it —
// so `contracts/` is the only home it can have without a second copy.
//
// WHY `diagnostic` IS NOT WRITTEN OUT. It is the shipped defaults. Writing them
// again would create a second copy that drifts the first time a default moves,
// which is the defect this round has closed five times. It is READ from
// `SETTINGS_SCHEMA`, which `tests/parity/settings-defaults-parity.test.ts` already
// holds against `package.json`. Move a default and the profile moves with it.
import { SETTINGS_SCHEMA } from '../config/settings-schema';

/** The four settings that decide how much unredacted evidence is retained. */
export interface PrivacyProfileSettings {
  readonly loggingVerbose: boolean;
  readonly rawTranscriptMode: 'always' | 'errors-only' | 'off';
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
}

export type PrivacyProfileName = 'ephemeral' | 'diagnostic' | 'forensic';

export interface PrivacyProfile {
  readonly name: PrivacyProfileName;
  /** Who this is for, in one sentence. */
  readonly audience: string;
  readonly settings: PrivacyProfileSettings;
  /**
   * What this profile does NOT change.
   *
   * FR-R3-127 D3 — a profile named `ephemeral` that quietly left 256 MiB of
   * unredacted Git diffs under `<globalStorage>/checkpoints/` for two weeks would
   * be the exact euphemism this feature exists to remove. Every profile says what
   * it leaves alone.
   */
  readonly residual: readonly string[];
}

const schemaNumber = (key: string, field: 'default' | 'min' | 'max'): number => {
  const entry = (SETTINGS_SCHEMA as Record<string, { default?: unknown; min?: number; max?: number } | undefined>)[
    key
  ];
  const value = field === 'default' ? entry?.default : entry?.[field];
  if (typeof value !== 'number') {
    throw new Error(`privacy profiles: ${key}.${field} is not a number in SETTINGS_SCHEMA`);
  }
  return value;
};

const AGE_KEY = 'schegent.logging.sessionRetentionMaxAgeDays';
const BYTES_KEY = 'schegent.logging.sessionRetentionMaxBytes';

/**
 * Residuals shared by all three, because they are true of all three. Stated on
 * each profile rather than once at the top: an operator reads the profile they are
 * choosing, not the preamble above it.
 */
const COMMON_RESIDUALS: readonly string[] = Object.freeze([
  'Recovery checkpoints keep unredacted binary Git diffs under private extension storage for 14 days ' +
    'and 256 MiB. That bound is a constant, not a setting, and no profile changes it — FR-R3-012 ' +
    'decided that deliberately, because a wrong value is silent data loss in a directory an operator ' +
    'never opens. To reduce it, delete a Run\'s evidence.',
  'The structured audit log is retained and is redacted. A profile does not turn evidence off; it ' +
    'decides how much UNREDACTED evidence is kept.',
  '.gitignore keeps evidence out of commits. It does not stop backup, sync, or endpoint-management ' +
    'tooling from copying it off the machine — which is the reason to pick `ephemeral` at all.',
  'A profile is not a permission boundary. An uncontained backend runs under your local authority ' +
    'and can read the evidence store whatever profile is selected (FR-R3-125).'
]);

/**
 * The three profiles.
 *
 * `ephemeral` and `forensic` are choices and are written out. `diagnostic` is a
 * reflection of the shipped defaults and is derived.
 */
export function privacyProfiles(): readonly PrivacyProfile[] {
  return Object.freeze([
    Object.freeze({
      name: 'ephemeral' as const,
      audience:
        'A shared account, a managed endpoint, or a home directory that is backed up or synchronized ' +
        'off the machine. Keeps the least unredacted evidence this product can keep.',
      settings: Object.freeze({
        loggingVerbose: false,
        // Not `errors-only`. A profile called ephemeral that still retained an
        // unredacted transcript for every failed Run would be a euphemism.
        rawTranscriptMode: 'off' as const,
        sessionRetentionMaxAgeDays: schemaNumber(AGE_KEY, 'min'),
        sessionRetentionMaxBytes: schemaNumber(BYTES_KEY, 'min')
      }),
      residual: Object.freeze([
        'Raw capture is OFF, so a failed Run leaves no transcript to diagnose from. That is the trade ' +
          'this profile makes, and it is the whole reason `diagnostic` is the default.',
        ...COMMON_RESIDUALS
      ])
    }),
    Object.freeze({
      name: 'diagnostic' as const,
      audience:
        'A single informed local operator debugging their own Runs on a machine they control. These ' +
        'are the shipped defaults, named here so that keeping them is a decision rather than an ' +
        'absence of one.',
      settings: Object.freeze({
        loggingVerbose: false,
        // `errors-only`: successful Runs retain nothing raw. The exposure is
        // specific to failed, canceled and paused Runs — which is also where the
        // debugging value is, and that tension is what the profiles exist for.
        rawTranscriptMode: 'errors-only' as const,
        sessionRetentionMaxAgeDays: schemaNumber(AGE_KEY, 'default'),
        sessionRetentionMaxBytes: schemaNumber(BYTES_KEY, 'default')
      }),
      residual: Object.freeze([
        'A failed, canceled or paused Run retains an UNREDACTED transcript — operator prompts, source, ' +
          'and model output — for the session-retention window above.',
        ...COMMON_RESIDUALS
      ])
    }),
    Object.freeze({
      name: 'forensic' as const,
      audience:
        'An incident you expect to investigate later, on a machine whose disk you are willing to treat ' +
        'as holding the material. Retains the most, for the longest.',
      settings: Object.freeze({
        loggingVerbose: true,
        rawTranscriptMode: 'always' as const,
        sessionRetentionMaxAgeDays: 365,
        sessionRetentionMaxBytes: 4 * 1024 * 1024 * 1024
      }),
      residual: Object.freeze([
        'WARNING: every Run — including every successful one — retains an unredacted transcript, and ' +
          'verbose diagnostics are captured unredacted as well. On a shared or synchronized machine ' +
          'this is the wrong profile.',
        ...COMMON_RESIDUALS
      ])
    })
  ]);
}

export function privacyProfile(name: PrivacyProfileName): PrivacyProfile {
  const found = privacyProfiles().find((profile) => profile.name === name);
  if (found === undefined) throw new Error(`unknown privacy profile: ${name}`);
  return found;
}

export type DetectedPrivacyProfile =
  | { readonly kind: 'profile'; readonly name: PrivacyProfileName }
  | {
      readonly kind: 'custom';
      /** The profile the current values are closest to. */
      readonly nearest: PrivacyProfileName;
      /** The fields that differ from `nearest`, so the operator can act on it. */
      readonly differs: readonly (keyof PrivacyProfileSettings)[];
    };

const FIELDS: readonly (keyof PrivacyProfileSettings)[] = Object.freeze([
  'loggingVerbose',
  'rawTranscriptMode',
  'sessionRetentionMaxAgeDays',
  'sessionRetentionMaxBytes'
]);

/**
 * Which profile the current settings are, or `custom` with what to look at.
 *
 * `custom` on its own tells an operator nothing they can act on, so it carries the
 * nearest profile and the fields that differ from it — the smallest thing that
 * answers "was my drift deliberate?".
 *
 * Nearest is by count of matching fields, ties broken toward `diagnostic`: the
 * shipped default is the most useful reference point when nothing else is closer.
 */
export function detectPrivacyProfile(settings: PrivacyProfileSettings): DetectedPrivacyProfile {
  const scored = privacyProfiles().map((profile) => ({
    profile,
    differs: FIELDS.filter((field) => settings[field] !== profile.settings[field])
  }));
  const exact = scored.find((entry) => entry.differs.length === 0);
  if (exact !== undefined) return { kind: 'profile', name: exact.profile.name };

  let best = scored[0]!;
  for (const entry of scored) {
    if (entry.differs.length < best.differs.length) best = entry;
    else if (entry.differs.length === best.differs.length && entry.profile.name === 'diagnostic') {
      best = entry;
    }
  }
  return { kind: 'custom', nearest: best.profile.name, differs: best.differs };
}
