/**
 * FR-R3-145 (T1574) — a `WorkspaceState` memento key string may not also name a
 * setting.
 *
 * Every one of the nineteen entries in `KEYS` begins with `schegent.`, so the
 * memento shares its whole namespace with the configuration surface. That is
 * what makes this a class rather than an incident: nothing about the two stores
 * relates them, so a shared string is not a link, it is two stores answering to
 * one name and no mechanism keeping them equal. The value an operator sets in
 * `settings.json` and the value the host wrote into `workspaceState` are then
 * both "the setting", and which one a reader gets depends on which accessor
 * they happened to reach.
 *
 * This is not hypothetical. `KEYS.queueGlobalConcurrencyCap` was byte-identical
 * to the manifest property `schegent.queue.globalConcurrencyCap`, and the two
 * halves of the queue configuration surface landed on opposite sides of it: the
 * modal seeded its input from the configuration projection and its save wrote
 * the memento, so the operator's own save read back as though it had not
 * happened, while the drain gated on the memento the whole time. FR-R3-145
 * removed the manifest property, which is why assertion 1 below passes today and
 * would have failed against the tree this feature branched from.
 *
 * TWO ASSERTIONS, AND WHY ONE WOULD NOT DO
 *
 * The item that filed this guard stated it as one sentence — that it "fails
 * against the pre-fix tree at both `queueDefaultId` and
 * `queueGlobalConcurrencyCap`". Measured, that sentence is false of either
 * assertion taken alone, and true only of the pair:
 *
 *   1. Against **declared** configuration keys — the properties in
 *      `contributes.configuration`, read from `package.json` on disk. This is
 *      what VS Code itself offers an operator in the settings UI. Exactly one
 *      memento key ever collided here, the cap. `queue.defaultQueueId` never
 *      did, because no such property was ever declared.
 *
 *   2. Against **payload** keys — `schegent.` plus a `KEY_SPECS` key. This is
 *      the host's own typed settings layer, and a `KEY_SPECS` entry is a live
 *      read and write target for `readGeneralSettings` / `writeGeneralSettings`
 *      whether or not the manifest declares a matching property. Under this
 *      assertion `queue.defaultQueueId` was a genuine collision: a payload key
 *      for a configuration that did not exist, sharing a string with the memento
 *      the host actually routed on.
 *
 * So the two sets are not nested and neither subsumes the other. A guard holding
 * only assertion 1 would have let an undeclared payload key collide silently —
 * which is the shape the second half of this feature's defect took. A guard
 * holding only assertion 2 would miss a manifest property added with no
 * `KEY_SPECS` entry, which is how a setting arrives before anyone types it.
 *
 * EQUALITY, NOT PREFIX, AND THAT IS DELIBERATE
 *
 * `KEYS.queue` is `schegent.queue` and `KEYS.watchdog` is `schegent.watchdog`;
 * both are proper prefixes of real configuration keys
 * (`schegent.queue.globalConcurrencyCap` was one, `schegent.watchdog.pollIntervalMinutes`
 * still is). Neither is a collision: VS Code addresses a property by its whole
 * dotted name, so a shorter memento key can never be reached by a configuration
 * read. A prefix rule would fail on both and would have to carry an exemption
 * list for them from its first run, which is how a gate becomes a place people
 * add names. The last test below pins that distinction so the predicate cannot
 * quietly widen into one that needs excuses.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { KEY_SPECS } from '../../src/config/general-settings';
import { KEYS } from '../../src/state/workspace-state';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The namespace both stores are addressed under. */
const SETTING_PREFIX = 'schegent.';

interface ManifestBlock {
  readonly properties?: Readonly<Record<string, unknown>>;
}

/**
 * The `schegent.*` properties VS Code contributes, read from the shipped
 * manifest rather than imported.
 *
 * From disk on purpose, following `tests/unit/config/settings-scope-parity.test.ts`:
 * the manifest is data, and the file VS Code parses is the only copy that
 * decides what an operator is offered. A mirror in TypeScript would be one more
 * restatement of the facts this guard exists to keep apart.
 */
function declaredSettingKeys(manifestPath: string): ReadonlySet<string> {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    contributes?: { configuration?: ManifestBlock | readonly ManifestBlock[] };
  };
  const configuration = parsed.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : [configuration];
  const declared = new Set<string>();
  for (const block of blocks) {
    for (const key of Object.keys(block?.properties ?? {})) {
      if (key.startsWith(SETTING_PREFIX)) declared.add(key);
    }
  }
  return declared;
}

/** Every memento key, paired with the field it is declared under. */
const MEMENTO_ENTRIES: ReadonlyArray<readonly [field: string, key: string]> = Object.entries(
  KEYS
).map(([field, key]) => [field, key as string] as const);

const DECLARED_SETTING_KEYS = declaredSettingKeys(resolve(REPO_ROOT, 'package.json'));

/**
 * `schegent.` plus every `KEY_SPECS` key — the strings `readGeneralSettings`
 * builds when it asks the configuration for a value.
 */
const PAYLOAD_SETTING_KEYS: ReadonlySet<string> = new Set(
  Object.keys(KEY_SPECS).map((key) => `${SETTING_PREFIX}${key}`)
);

/** Names both sides of a collision, so a failure needs no second lookup. */
function collisionsAgainst(candidates: ReadonlySet<string>, side: string): readonly string[] {
  return MEMENTO_ENTRIES.filter(([, key]) => candidates.has(key))
    .map(([field, key]) => `KEYS.${field} === ${key} (${side})`)
    .sort();
}

describe('memento keys do not collide with configuration keys (FR-R3-145, T1574)', () => {
  it('reads a populated memento map, manifest and payload key set', () => {
    // Non-vacuity, stated rather than assumed. Both assertions below are
    // "nothing in set A is in set B", which is trivially true when either set is
    // empty — and either can empty itself without anyone noticing: a renamed
    // `KEYS` export, a manifest whose `contributes.configuration` shape changes
    // from an object to an array of blocks, a `KEY_SPECS` import that resolves
    // to a barrel re-export. Any of those turns this file into a gate that
    // passes on every tree, which is precisely the failure FR-R3-145 was filed
    // about one gate over.
    expect(
      MEMENTO_ENTRIES.length,
      'the memento key map came back (near) empty — `KEYS` no longer enumerates the ' +
        'workspace state keys, so both assertions below compare nothing to something.'
    ).toBeGreaterThanOrEqual(15);
    expect(
      DECLARED_SETTING_KEYS.size,
      'no `schegent.*` property was read out of `package.json` — the manifest shape this ' +
        'parser expects has changed, so assertion 1 would pass against any memento map.'
    ).toBeGreaterThanOrEqual(30);
    expect(
      PAYLOAD_SETTING_KEYS.size,
      '`KEY_SPECS` came back (near) empty, so assertion 2 would pass against any memento map.'
    ).toBeGreaterThanOrEqual(15);

    // Three anchors, one per set, so a set that is populated with the wrong
    // thing fails as loudly as one that is empty.
    expect(MEMENTO_ENTRIES.map(([, key]) => key)).toContain(KEYS.queue);
    expect(DECLARED_SETTING_KEYS.has(`${SETTING_PREFIX}cli.path`)).toBe(true);
    expect(PAYLOAD_SETTING_KEYS.has(`${SETTING_PREFIX}cli.path`)).toBe(true);
  });

  it('no memento key string equals a declared schegent.* configuration key', () => {
    // Assertion 1. `schegent.queue.globalConcurrencyCap` was the one collision
    // in this direction, and it is gone: the manifest property was removed
    // because no scheduling path ever read it, leaving the memento as the cap's
    // single authority.
    expect(
      collisionsAgainst(DECLARED_SETTING_KEYS, 'declared in contributes.configuration'),
      'a workspace memento key has the same string as a contributed setting. VS Code will ' +
        'show an operator that setting while the host reads and writes its own value under ' +
        'the identical name, and nothing propagates between the two. Rename the memento key ' +
        'or drop the contribution; do not add an exemption.'
    ).toEqual([]);
  });

  it('no memento key string equals `schegent.` + a KEY_SPECS payload key', () => {
    // Assertion 2, and the distinction from assertion 1 is the whole reason both
    // exist: a `KEY_SPECS` entry is a configuration read and write target even
    // when the manifest declares no property for it. `queue.defaultQueueId` was
    // exactly that — undeclared, so invisible to assertion 1, and colliding with
    // `KEYS.queueDefaultId`, which is the string the host routed unassigned tasks
    // on. Two surfaces answered "which queue is the default" from two stores.
    expect(
      collisionsAgainst(PAYLOAD_SETTING_KEYS, 'a KEY_SPECS payload key'),
      'a workspace memento key has the same string as a key the typed settings layer reads ' +
        'and writes. `readGeneralSettings` and `writeGeneralSettings` will address the ' +
        'configuration under that name while the memento holds a second value under it.'
    ).toEqual([]);
  });

  it('treats a memento key that is a prefix of a setting key as no collision', () => {
    // The positive control for the predicate above: it must be equality, and it
    // must be able to tell equality from containment. `schegent.watchdog` is a
    // memento key and `schegent.watchdog.pollIntervalMinutes` is a real setting;
    // if the two assertions ever start failing on that pair, the predicate has
    // widened into a prefix rule and the fix is the predicate, not an exemption.
    const prefixOfASetting = [...DECLARED_SETTING_KEYS].some((key) =>
      key.startsWith(`${KEYS.watchdog}.`)
    );
    expect(
      prefixOfASetting,
      'no declared setting sits under the `schegent.watchdog` memento key any more, so this ' +
        'control no longer demonstrates anything. Point it at another memento key that is a ' +
        'proper prefix of a live setting, or delete it with a note saying none is left.'
    ).toBe(true);
    expect(DECLARED_SETTING_KEYS.has(KEYS.watchdog)).toBe(false);
    expect(PAYLOAD_SETTING_KEYS.has(KEYS.watchdog)).toBe(false);
  });
});
