// Feature 011 — US2 P2: unified Settings surface.
//
// Covers:
//   SC-004 — the projection carries a typed value AND a scope indicator
//            (workspace/user/default) for every key the host accepts.
//   SC-005 — `writeGeneralSettings()` persists to Workspace target;
//            re-reading after a write returns the new value (survives
//            "reload" — simulated by re-invoking `readGeneralSettings`).
//
// FR-R3-145 (T1570) — the first of those two used to be titled "every scalar
// `schegent.*` key is in the projected GeneralSettings", and it was not that.
// Its cardinality assertion compared `Object.keys(snap.scopes).length` to
// `ALLOWED_KEYS.size`; `ALLOWED_KEYS` is `new Set(Object.keys(KEY_SPECS))` and
// `snap.scopes` is filled by looping `Object.keys(KEY_SPECS)`, so both sides
// reduced to the same number and the check compared `KEY_SPECS` to itself. It
// never read `package.json`, so a key added to the manifest and surfaced nowhere
// failed nothing — and it drifted fourteen keys behind its own comment ("10 keys
// in allowlist") without ever going red. The manifest-derived gate that can fail
// is the second describe block in this file; the one property the old assertion
// really did hold — that no two `KEY_SPECS` entries share a `typedField` — is
// asserted there directly, saying what it means.
//
// Drives `readGeneralSettings()` and `writeGeneralSettings()` directly
// against a fake `vscode.WorkspaceConfiguration` to keep the test
// hermetic and avoid touching the real settings.json. The router-side
// CMD_SAVE_GENERAL_SETTINGS plumbing is covered by the router unit
// tests in tests/unit/ui/sidebar/general-settings-router.test.ts.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  readGeneralSettings,
  writeGeneralSettings,
  KEY_SPECS,
  type GeneralSettingsConfig
} from '../../src/config/general-settings';

interface InspectResult<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
}

class FakeWorkspaceConfig {
  public readonly updateCalls: Array<{ key: string; value: unknown; target: number }> = [];
  constructor(
    private readonly defaults: Record<string, unknown> = {},
    private readonly workspace: Record<string, unknown> = {},
    private readonly user: Record<string, unknown> = {}
  ) {}

  get<T>(key: string, fallback: T): T {
    if (key in this.workspace) return this.workspace[key] as T;
    if (key in this.user) return this.user[key] as T;
    if (key in this.defaults) return this.defaults[key] as T;
    return fallback;
  }

  inspect<T>(key: string): InspectResult<T> | undefined {
    const out: InspectResult<T> = {};
    if (key in this.defaults) out.defaultValue = this.defaults[key] as T;
    if (key in this.user) out.globalValue = this.user[key] as T;
    if (key in this.workspace) out.workspaceValue = this.workspace[key] as T;
    return out;
  }

  update(key: string, value: unknown, target: number): Promise<void> {
    this.updateCalls.push({ key, value, target });
    this.workspace[key] = value;
    return Promise.resolve();
  }
}

const DEFAULTS: Record<string, unknown> = {
  'cli.path': 'claude',
  'logging.verbose': false,
  'loop.maxIterations': 10,
  'invocation.idleTimeoutSeconds': 5400,
  'invocation.maxDurationSeconds': 21600,
  'watchdog.pollIntervalMinutes': 30,
  'audit.rotation.sizeMB': 5,
  'audit.rotation.maxAgeDays': 30,
  defaultPipelineId: 'speckit-new-feature',
  fatalSignatures: []
};

function makeConfig(opts: {
  workspace?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}): GeneralSettingsConfig {
  return new FakeWorkspaceConfig(
    { ...DEFAULTS },
    opts.workspace ?? {},
    opts.user ?? {}
  ) as unknown as GeneralSettingsConfig;
}

describe('Feature 011 — Settings surface (US2)', () => {
  it('SC-004: the projection carries a typed value and a scope for every accepted key', () => {
    const config = makeConfig();
    const snap = readGeneralSettings(config);

    // Spot-checks across all four runtime types the projection produces, so a
    // reader can see what "typed" means here without chasing `KEY_SPECS`.
    expect(typeof snap.cliPath).toBe('string');
    expect(typeof snap.loggingVerbose).toBe('boolean');
    expect(typeof snap.loopMaxIterations).toBe('number');
    expect(typeof snap.invocationIdleTimeoutSeconds).toBe('number');
    expect(typeof snap.invocationMaxDurationSeconds).toBe('number');
    expect(typeof snap.watchdogPollIntervalMinutes).toBe('number');
    expect(typeof snap.auditRotationSizeMB).toBe('number');
    expect(typeof snap.auditRotationMaxAgeDays).toBe('number');
    expect(typeof snap.defaultPipelineId).toBe('string');
    expect(Array.isArray(snap.fatalSignatures)).toBe(true);

    // Every accepted key must reach the `scopes` map, and every value in it must
    // be one of the three scopes the webview knows how to label. Driven off
    // `KEY_SPECS` rather than a count: the count is what made the predecessor
    // unfalsifiable, whereas "this key's typed field has a scope" is a claim the
    // projection can actually fail. `readGeneralSettings` builds the map as a
    // bare `Record<string, SettingScope>` and assigns it into the frozen result,
    // so a missing entry is a real runtime state and not one the type rules out.
    for (const [key, spec] of Object.entries(KEY_SPECS)) {
      const scope = snap.scopes[spec.typedField];
      expect(scope, `no scope projected for ${key} (${String(spec.typedField)})`).toBeDefined();
      expect(['workspace', 'user', 'default']).toContain(scope);
    }
  });

  it('SC-005: a write to workspace persists; re-read reflects the new value', async () => {
    const config = makeConfig();

    const before = readGeneralSettings(config);
    expect(before.loopMaxIterations).toBe(10);
    expect(before.scopes.loopMaxIterations).toBe('default');

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 25,
      'logging.verbose': true
    });
    expect(result.ok).toBe(true);

    // Simulate "reopen" by reading the same backing store again — the
    // workspace overrides we just wrote must now dominate the defaults.
    const after = readGeneralSettings(config);
    expect(after.loopMaxIterations).toBe(25);
    expect(after.loggingVerbose).toBe(true);
    expect(after.scopes.loopMaxIterations).toBe('workspace');
    expect(after.scopes.loggingVerbose).toBe('workspace');
  });

  it('a transactional reject does NOT mutate any key', async () => {
    const config = makeConfig();
    const before = readGeneralSettings(config);

    const result = await writeGeneralSettings(config, {
      'loop.maxIterations': 42,
      'unknown.key': 'oops'
    });
    expect(result.ok).toBe(false);

    const after = readGeneralSettings(config);
    expect(after.loopMaxIterations).toBe(before.loopMaxIterations);
    expect(after.scopes.loopMaxIterations).toBe('default');
  });

  it('fatalSignatures round-trips through write+read', async () => {
    const config = makeConfig();
    const result = await writeGeneralSettings(config, {
      fatalSignatures: ['context length exceeded', 'token quota exceeded']
    });
    expect(result.ok).toBe(true);

    const snap = readGeneralSettings(config);
    expect(snap.fatalSignatures).toEqual([
      'context length exceeded',
      'token quota exceeded'
    ]);
    expect(snap.scopes.fatalSignatures).toBe('workspace');
  });

  it('user-scope values do not override an explicit workspace value', () => {
    const config = makeConfig({
      workspace: { 'cli.path': '/opt/claude' },
      user: { 'cli.path': '/usr/local/bin/claude' }
    });
    const snap = readGeneralSettings(config);
    expect(snap.cliPath).toBe('/opt/claude');
    expect(snap.scopes.cliPath).toBe('workspace');
  });
});

// ── FR-R3-145 (T1570) — the coverage gate, rebuilt so it can fail ──────────

const REPO_ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PREFIX = 'schegent.';

/**
 * The Settings components. Scanned as a tree rather than as one named file
 * because `FR-R3-143` (T1557) decomposes `GeneralSettingsTab.svelte` into one
 * component per group: a gate that read a single path would report the whole
 * surface as unrendered the day that lands, and the fix would look like widening
 * the ledger.
 */
const SETTINGS_COMPONENT_ROOT = path.join(
  REPO_ROOT,
  'webview-ui',
  'src',
  'components',
  'settings'
);

/**
 * FR-004 — the key set comes from the shipped manifest, read from disk.
 *
 * Read rather than imported, and read here rather than taken from `KEY_SPECS`:
 * `package.json` is the only copy VS Code enforces, and deriving the expected
 * set from a host table is exactly the loop that made the predecessor
 * unfalsifiable. The parse deliberately mirrors
 * `tests/unit/config/settings-scope-parity.test.ts`, which reads the same file
 * for the neighbouring question about scope.
 */
function manifestSettingKeys(): ReadonlySet<string> {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { contributes?: { configuration?: unknown } };
  const configuration = parsed.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : [configuration];
  const keys = new Set<string>();
  for (const block of blocks) {
    const properties = (block as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!properties) continue;
    for (const key of Object.keys(properties)) {
      if (!key.startsWith(MANIFEST_PREFIX)) continue;
      keys.add(key.slice(MANIFEST_PREFIX.length));
    }
  }
  return keys;
}

function svelteFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `__tests__` holds fixtures that restate field specs verbatim
    // (`BackendHealthSection.test.ts` copies all three backend rows). Counting a
    // fixture as a rendered control would let a test keep a key exempt from the
    // gate that is supposed to be measuring the product.
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...svelteFilesUnder(full));
    } else if (entry.name.endsWith('.svelte')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A field spec declares the setting it writes as `ipcKey: 'audit.rotation.sizeMB'`,
 * or — when the wire name and the typed field name coincide, as they do for
 * `defaultPipelineId` — as a bare `key: '…'`. Both forms are collected and then
 * intersected with the declared set, which drops the camelCase `key:` halves
 * (`cliPath`, `loopMaxIterations`) without needing to model the component's
 * `ipcKey ?? key` fallback.
 *
 * The intersection is the loose step: any single-quoted `key:`/`ipcKey:` literal
 * that happens to equal a manifest key counts as rendered. Two assertions below
 * hold that honest — no ledger row may name a key this finds, and the rendered
 * set must stay strictly smaller than the declared one — so an extractor that
 * started matching everything fails rather than silently emptying the gate.
 */
const FIELD_KEY_LITERAL = /(?:^|[\s,{])(?:ipcKey|key)\s*:\s*'([^']+)'/g;

function renderedSettingKeys(declared: ReadonlySet<string>): ReadonlySet<string> {
  const rendered = new Set<string>();
  for (const file of svelteFilesUnder(SETTINGS_COMPONENT_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(FIELD_KEY_LITERAL)) {
      if (declared.has(match[1])) rendered.add(match[1]);
    }
  }
  return rendered;
}

/**
 * FR-005 — an exemption is owned, justified and dated.
 *
 * The shape is `tests/lint/svelte-surface-reachability.test.ts`'s, for its
 * reason: a bare reason string records why without recording who, and nothing
 * makes it expire. One field means something different here. There, `owner` is
 * "a person, not a feature id"; here it is the work that deletes the row —
 * `FR-R3-143` and `FR-R3-144` discharge part of their own acceptance by removing
 * rows from this ledger, so naming the item is naming who can be asked. For the
 * three rows that never leave, it names the surface that renders the setting
 * instead.
 */
interface Exemption {
  /** Who removes this row: the sibling item, or the surface that already owns the setting. */
  readonly owner: string;
  readonly reason: string;
  /**
   * `YYYY-MM-DD`, after which the row fails until it is renewed or removed — or
   * `PERMANENT` for a setting whose control is somewhere else by design. A date
   * on one of those three would be a deadline for work nobody intends to do,
   * which teaches the next reader to push dates rather than delete rows.
   */
  readonly reviewBy: string;
}

const PERMANENT = 'permanent';

/**
 * The ledger lives here, in the test file, and not in a shared module (spec C4).
 *
 * `FR-R3-143` and `FR-R3-144` discharge part of their acceptance by deleting
 * rows, and a row's deletion belongs in the same diff as the control that
 * replaced it. A shared module would let a row be removed in a diff this gate
 * never appears in — which is how an exemption outlives the thing it excused.
 *
 * There is deliberately no row for `queue.globalConcurrencyCap`. It was the one
 * setting this feature disposed of rather than excused: the cap the drain gates
 * on lives in the workspace memento, the configuration key nothing read is gone
 * from the manifest, and a key that does not exist needs no excuse.
 */
const EXEMPTIONS: ReadonlyMap<string, Exemption> = new Map<string, Exemption>([
  // ── Permanently elsewhere. Steady state; these rows never leave. ──────────
  [
    'models',
    {
      owner: 'Builder — Models tab',
      reason:
        'A model catalog, not a scalar. Rows are authored on the Builder\'s Models tab, ' +
        'where a model is a record with its own validation, and no input box on the ' +
        'Settings tab could hold one.',
      reviewBy: PERMANENT
    }
  ],
  [
    'fatalSignatures',
    {
      owner: 'Settings — FatalSignaturesTab.svelte',
      reason:
        'An array of strings with its own sub-tab. `FatalSignaturesTab` is a sibling of ' +
        '`GeneralSettingsTab`, not a child of it, so the setting is reachable to an ' +
        'operator while being absent from the field lists this gate scans.',
      reviewBy: PERMANENT
    }
  ],
  [
    'invocation.timeoutSeconds',
    {
      owner: 'FR-R3-075 — deprecated manifest alias',
      reason:
        'A deprecated alias kept only so an explicit legacy value still resolves. It is ' +
        'read-only to the host and has no `KEY_SPECS` entry on purpose: giving it a ' +
        'control would put two keys on one typed field and let the unset alias default ' +
        'clobber an explicit value of the renamed key.',
      reviewBy: PERMANENT
    }
  ],

  // ── Owned by FR-R3-143 (T1557–T1562): the twelve settings with no operator
  //    surface anywhere in the product. Each row leaves with its control. ────
  //
  // All eight have left. `cli.inheritEnvironment`, `cli.environmentMode`,
  // `cli.environmentAllowlist` and `backend.probeTimeoutSeconds` are rendered by
  // `PROCESS_ENVIRONMENT_FIELDS` (T031); `ui.confirmations.enable` and
  // `multiRoot.suppressWarning` by `UI_TRUST_FIELDS` (T032); and
  // `trust.allowCustomPhases` / `trust.allowCustomRetryConditions` by
  // `TrustDisclosure.svelte` (T039), READ-ONLY — the gate counts a key as
  // surfaced when the operator can see what is in force, which is the whole
  // question a capability the host resolves can answer (spec C1 records why a
  // control would ack `accepted` and change nothing). Their rows are deleted
  // rather than renewed — a row for a rendered key is the ledger's own
  // `already rendered` failure, so leaving one would fail FR-005 here.

  // ── Owned by FR-R3-144 (T1563–T1568): the backend and spend surface. ──────
  //
  // Three rows were DELETED here, not renewed: `backend.runner`,
  // `spend.maxUsdPerRun` and `spend.maxTokensPerRun` are rendered by
  // `GeneralSettingsTab.svelte` as of T031/T036, and a ledger row for a rendered
  // key is this ledger's own `already rendered` failure. The rows were written by
  // FR-R3-145 (T1570) precisely so their disappearance would be the evidence this
  // feature landed; deleting them is that evidence.
  //
  // One row stays, and it is not an omission.
  [
    'backend.uncontainedBackends',
    {
      owner: 'FR-R3-144 (T1564, T1566)',
      reason:
        'Surfaced by the per-backend grant button (T034), which is NOT a settings field: it ' +
        'writes through its own confirmed IPC command rather than the draft path this gate ' +
        'scans for, so the key carries no `ipcKey:` literal to find. The row stays as the ' +
        'record of where it IS reachable — a control an operator can find, deliberately not ' +
        'a checkbox in a field list, because granting it widens what an unattended run may do.',
      reviewBy: '2026-12-31'
    }
  ]
]);

type LedgerProblemKind =
  | 'no owner'
  | 'no reason'
  | 'malformed reviewBy'
  | 'expired'
  | 'not declared'
  | 'already rendered';

interface LedgerProblem {
  readonly key: string;
  readonly kind: LedgerProblemKind;
  readonly detail: string;
}

/**
 * The same six kinds, as a value the positive control can iterate.
 *
 * A `Record<LedgerProblemKind, true>` is the point: TypeScript rejects this
 * literal if a kind joins the union and is not listed here, so the runtime list
 * cannot fall behind the type and the control below cannot quietly stop
 * demonstrating a rule that exists.
 */
const LEDGER_PROBLEM_KINDS: Record<LedgerProblemKind, true> = {
  'no owner': true,
  'no reason': true,
  'malformed reviewBy': true,
  expired: true,
  'not declared': true,
  'already rendered': true
};

const ALL_LEDGER_PROBLEM_KINDS = Object.keys(LEDGER_PROBLEM_KINDS) as readonly LedgerProblemKind[];

/** `YYYY-MM-DD`, and a day that exists. `2026-02-30` parses and rolls forward. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().startsWith(value);
}

/**
 * Every rule the ledger enforces, in one pure function.
 *
 * `declared`, `rendered` and `today` are parameters and never read from inside,
 * for the reason the reachability gate gives: with a well-formed ledger every
 * rule below is permanently green while still looking like a check. Injected,
 * the rules can be demonstrated against entries built in memory, which is what
 * the positive control does. `reviewBy` is compared lexicographically — exact
 * for `YYYY-MM-DD`, and it sidesteps the timezone question a `Date` comparison
 * would introduce. The boundary is inclusive: a row due for review today has not
 * expired.
 */
function ledgerProblems(
  entries: ReadonlyMap<string, Exemption>,
  declared: ReadonlySet<string>,
  rendered: ReadonlySet<string>,
  today: string
): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  for (const [key, entry] of entries) {
    if (entry.owner.trim() === '') {
      problems.push({
        key,
        kind: 'no owner',
        detail:
          'no owner — name the item that will delete this row, or the surface that renders ' +
          'the setting instead. An unowned exemption is the thing this ledger exists to prevent'
      });
    }
    if (entry.reason.trim() === '') {
      problems.push({ key, kind: 'no reason', detail: 'no reason recorded' });
    }
    if (entry.reviewBy !== PERMANENT) {
      if (!isCalendarDate(entry.reviewBy)) {
        problems.push({
          key,
          kind: 'malformed reviewBy',
          detail: `reviewBy "${entry.reviewBy}" is neither "${PERMANENT}" nor a YYYY-MM-DD calendar date`
        });
      } else if (entry.reviewBy < today) {
        problems.push({
          key,
          kind: 'expired',
          detail: `expired — reviewBy ${entry.reviewBy} is before ${today}. Renew it with a new date, or remove the entry`
        });
      }
    }
    if (!declared.has(key)) {
      problems.push({
        key,
        kind: 'not declared',
        detail:
          `the manifest declares no schegent.${key} — the row outlived the key it excused, ` +
          'and while it stands the key can come back unmeasured'
      });
    }
    if (rendered.has(key)) {
      problems.push({
        key,
        kind: 'already rendered',
        detail: `the Settings surface renders ${key} — delete the row, the control replaced it`
      });
    }
  }
  return problems;
}

/** FR-006 — declared, drawn nowhere, excused by nobody. */
function unaccountedKeys(
  declared: ReadonlySet<string>,
  rendered: ReadonlySet<string>,
  entries: ReadonlyMap<string, Exemption>
): string[] {
  return [...declared].filter((key) => !rendered.has(key) && !entries.has(key)).sort();
}

describe('FR-R3-145 (T1570) — every declared schegent.* setting is rendered or exempted', () => {
  const declared = manifestSettingKeys();
  const rendered = renderedSettingKeys(declared);
  const today = new Date().toISOString().slice(0, 10);

  it('reads a manifest and a component tree that are both non-trivial', () => {
    // Guards every assertion below. A manifest parse that yielded nothing, or a
    // component walk that matched nothing, would make the coverage check pass by
    // having nothing to check — which is the failure mode this whole block
    // exists to replace, arriving through a different door.
    expect(declared.size).toBeGreaterThan(30);
    expect(rendered.size).toBeGreaterThanOrEqual(17);

    // Named anchors for both spellings the extractor has to handle: an `ipcKey`
    // that differs from the typed field, and a bare `key` that does not.
    expect(rendered.has('cli.path')).toBe(true);
    expect(rendered.has('logging.verbose')).toBe(true);
    expect(rendered.has('defaultPipelineId')).toBe(true);

    // And the negative control on the extractor: it must not be matching the
    // whole manifest. `models`, `fatalSignatures` and `invocation.timeoutSeconds`
    // are declared and are not field specs on this surface, so the rendered set
    // is strictly smaller — permanently, since those three never move here.
    expect(rendered.size).toBeLessThan(declared.size);
    expect([...rendered].every((key) => declared.has(key))).toBe(true);
  });

  it('FR-006: names every declared key with neither a control nor a ledger row', () => {
    const unaccounted = unaccountedKeys(declared, rendered, EXEMPTIONS);
    expect(
      unaccounted,
      'declared in package.json, rendered by no Settings control, and excused by no ledger ' +
        'row. Render a control, or add an entry to EXEMPTIONS naming an owner, a reason and ' +
        `a review date: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });

  it('FR-005: every ledger row is owned, justified, in date, and still excusing something', () => {
    const problems = ledgerProblems(EXEMPTIONS, declared, rendered, today);
    expect(problems.map((p) => `${p.key}: ${p.detail}`)).toEqual([]);
  });

  it('the ledger rules reject a row that is unowned, stale, or superseded', () => {
    // The positive control, and it is not decoration. With a healthy ledger the
    // assertion above iterates real entries and finds nothing wrong every time,
    // so on its own it is a rule nobody has watched fail. These four synthetic
    // rows are the demonstration that each rule fires, and they are the in-tree
    // counterpart of the two falsification runs recorded for SC-002 and SC-003.
    // `A. Maintainer` is deliberately fictitious. A real name on a synthetic row
    // would read as a real owner to anyone grepping for one.
    const synthetic = new Map<string, Exemption>([
      ['models', { owner: '   ', reason: 'unowned', reviewBy: PERMANENT }],
      ['fatalSignatures', { owner: 'A. Maintainer', reason: '', reviewBy: PERMANENT }],
      // FR-R3-143 (T031, T032, then T041) — the expired row has now been moved
      // twice for the same reason, which is the reason it is finally parked on a
      // key that cannot move again. It was `ui.confirmations.enable`; T031/T032
      // rendered that, so it became `trust.allowCustomPhases`; T039 rendered
      // that too. Either way the synthetic entry reports BOTH `expired` and
      // `already rendered` (`ledgerProblems` accumulates; it does not stop at
      // the first), and the kind list carries a duplicate.
      //
      // `invocation.timeoutSeconds` is declared, undrawn, and PERMANENTLY so:
      // its ledger row records that a control would put two keys on one typed
      // field and let the unset alias clobber the renamed key. A key that is
      // waiting for a control is the wrong anchor for a fixture that needs one
      // that will never get one.
      [
        'invocation.timeoutSeconds',
        { owner: 'A. Maintainer', reason: 'stale', reviewBy: '2020-01-01' }
      ],
      ['cli.path', { owner: 'A. Maintainer', reason: 'superseded by a control', reviewBy: 'soon' }],
      ['queue.globalConcurrencyCap', { owner: 'A. Maintainer', reason: 'the removed key', reviewBy: PERMANENT }]
    ]);

    const kinds = ledgerProblems(synthetic, declared, rendered, today).map((p) => p.kind).sort();
    expect(kinds).toEqual([...ALL_LEDGER_PROBLEM_KINDS].sort());
  });

  it('FR-007: no two KEY_SPECS entries share a typedField', () => {
    // The single non-vacuous property the deleted cardinality assertion held: it
    // compared `Object.keys(snap.scopes).length` against `ALLOWED_KEYS.size`, and
    // two specs pointing at one typed field would have collapsed the scopes map
    // and shrunk the left side. That is worth keeping — a shared `typedField`
    // silently makes one key's value and scope overwrite the other's on every
    // read — so it is asserted here as itself, naming the collision rather than
    // reporting a number that came out one short.
    const owners = new Map<string, string[]>();
    for (const [key, spec] of Object.entries(KEY_SPECS)) {
      const field = String(spec.typedField);
      owners.set(field, [...(owners.get(field) ?? []), key]);
    }
    const collisions = [...owners.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([field, keys]) => `${field} is written by ${keys.join(' and ')}`);
    expect(collisions).toEqual([]);

    // Non-vacuity for the scan above: an empty or shrunken `KEY_SPECS` would
    // report no collisions with perfect honesty and no information.
    expect(owners.size).toBe(Object.keys(KEY_SPECS).length);
    expect(owners.size).toBeGreaterThan(20);
  });
});
