/**
 * FR-R3-013 (T442, T443) — the facts in ARCHITECTURE.md that can be checked, are.
 *
 * Every drift this guard exists for was introduced the same way: a change
 * updated the code in one commit and the prose in another, or in none. By the
 * time it landed the document stated the workspace-state schema version as `10`
 * in its Schema Versions table, `11` forty lines earlier, and the code said
 * `13`. A document that contradicts *itself* is worse than one uniformly stale,
 * because a reader loses the ability to trust either statement, and no amount of
 * care at review time catches it — the two numbers are nowhere near each other.
 *
 * What is pinned is deliberately narrow: the version constants, the migrator
 * list's completeness, and the documented values of settings and bounds. The
 * surrounding explanation stays human-written and is nobody's build failure.
 * That boundary is the whole design — a guard that pinned prose would be
 * rewritten every time a paragraph was improved, and a guard that is routinely
 * rewritten stops being read.
 *
 * The constants are **imported**, never regexed out of their source files. A
 * lint that greps for a constant it names in a string passes forever the day
 * that constant is renamed, which is the failure mode
 * `lint-anchor-grounding.test.ts` was written to catch one level up. An import
 * makes a rename a compile error here.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AUDIT_SCHEMA_VERSION } from '../../src/contracts/audit-events';
import { STATE_SCHEMA_VERSION } from '../../src/contracts/state-schema';
// FR-R3-145 (T1572) — `DEFAULT_GLOBAL_CONCURRENCY_CAP` moved here from
// `src/state/workspace-state.ts`, beside the ceiling it is bounded by.
import { DEFAULT_GLOBAL_CONCURRENCY_CAP, MAX_QUEUES } from '../../src/contracts/queue-bounds';
import { MAX_GLOBAL_CONCURRENCY_CAP } from '../../src/state/workspace-state';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARCH_REL = 'ARCHITECTURE.md';
const ARCH = fs.readFileSync(path.join(REPO_ROOT, ARCH_REL), 'utf8');
const ARCH_LINES = ARCH.split('\n');

/**
 * Every place the document states a number on a line that names a version constant,
 * and disagrees with it.
 *
 * Extracted by FR-R3-102 (FR-034) so the live assertion and its non-vacuity control
 * run **one** body. Two copies of a detector is how a gate comes to pass while its
 * control passes for a different reason.
 */
function disagreements(lines: readonly string[]): string[] {
  const wrong: string[] = [];
  for (const [name, value] of VERSION_CONSTANTS) {
    const assignment = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'g');
    lines.forEach((line, index) => {
      if (!line.includes(name)) return;
      const stated = [
        // A bare integer in a code span on the same line — `13`, `3`.
        ...[...line.matchAll(/`(\d+)`/g)].map((match) => Number(match[1])),
        // …and the assignment form, whose number sits inside a wider span.
        ...[...line.matchAll(assignment)].map((match) => Number(match[1]))
      ];
      for (const found of stated) {
        if (found === value) continue;
        wrong.push(
          `${ARCH_REL}:${index + 1} states \`${found}\` on a line naming ${name}, ` +
            `which is \`${value}\``
        );
      }
    });
  }
  return wrong;
}

/**
 * The same text with every run of whitespace collapsed to one space.
 *
 * Prose in this document is hard-wrapped, so a claim like "default `1`, range
 * `[1, 20]`" routinely spans a newline. Matching against the raw text would
 * make the guard fail on a reflow, which is a change that alters nothing it
 * cares about.
 */
const FLAT = ARCH.replace(/\s+/g, ' ');

/** Every constant whose value the document may state, with its true value. */
const VERSION_CONSTANTS = [
  ['STATE_SCHEMA_VERSION', STATE_SCHEMA_VERSION],
  ['AUDIT_SCHEMA_VERSION', AUDIT_SCHEMA_VERSION]
] as const;

interface SettingContribution {
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
}

function readContribution(key: string): SettingContribution {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes?: {
      configuration?:
        | { properties?: Record<string, SettingContribution> }
        | readonly { properties?: Record<string, SettingContribution> }[];
    };
  };
  const configuration = pkg.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : [configuration ?? {}];
  for (const block of blocks) {
    const found = block?.properties?.[key];
    if (found) return found;
  }
  throw new Error(`package.json contributes no setting named ${key}`);
}

/**
 * FR-R3-145 (T1570) — the same lookup, for a key that is expected to be absent.
 *
 * `readContribution` throws, which is right when the manifest entry is the
 * authority a claim is checked against. It is the wrong shape for asserting that
 * a contribution was REMOVED: a thrown error and a failed assertion read the
 * same in a report, and the absence is the thing being pinned.
 */
function contributionOrNull(key: string): SettingContribution | null {
  try {
    return readContribution(key);
  } catch {
    return null;
  }
}

/** The `## Schema Versions` block, so the row lookup cannot stray into another table. */
function schemaVersionsSection(): readonly string[] {
  const start = ARCH_LINES.findIndex((line) => line.trim() === '## Schema Versions');
  expect(
    start,
    `${ARCH_REL} no longer has a "## Schema Versions" heading; this guard reads that section`
  ).toBeGreaterThanOrEqual(0);
  const rest = ARCH_LINES.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * One row of the Schema Versions table, split into cells.
 *
 * `\`${constant}\`` rather than the bare name because `STATE_SCHEMA_VERSION`
 * also appears in the Extension Points table further down ("bump
 * `STATE_SCHEMA_VERSION` if shape changes"), and a whole-document row search
 * would find whichever came first.
 */
function schemaRow(constant: string): readonly string[] {
  const row = schemaVersionsSection().find(
    (line) => line.startsWith('|') && line.includes(`\`${constant}\``)
  );
  expect(
    row,
    `the Schema Versions table in ${ARCH_REL} has no row naming \`${constant}\``
  ).toBeTruthy();
  return (row as string).split('|').map((cell) => cell.trim());
}

const CURRENT_CELL = 3;
const MIGRATORS_CELL = 4;

/** A claim stated near an anchor, tolerant of rewording between the two. */
function claimNear(anchor: string, pattern: RegExp, window = 240): RegExpMatchArray | null {
  const at = FLAT.indexOf(anchor);
  if (at === -1) return null;
  return FLAT.slice(at, at + window).match(pattern);
}

describe('FR-R3-013 — ARCHITECTURE.md schema and defaults parity', () => {
  it('the Schema Versions table states each constant’s current value', () => {
    for (const [name, value] of VERSION_CONSTANTS) {
      expect(
        schemaRow(name)[CURRENT_CELL],
        `${ARCH_REL}: the Schema Versions row for \`${name}\` states ` +
          `${schemaRow(name)[CURRENT_CELL]} in its Current column; the constant is \`${value}\`. ` +
          `Edit the table in ${ARCH_REL}.`
      ).toBe(`\`${value}\``);
    }
  });

  it('the migrator list covers every step up to the current state version', () => {
    const cell = schemaRow('STATE_SCHEMA_VERSION')[MIGRATORS_CELL];
    const steps = [...cell.matchAll(/(\d+)→(\d+)/g)].map((match) => ({
      from: Number(match[1]),
      to: Number(match[2])
    }));
    const declared = new Set(steps.map((step) => `${step.from}→${step.to}`));

    const missing: string[] = [];
    for (let version = 2; version <= STATE_SCHEMA_VERSION; version += 1) {
      if (!declared.has(`${version - 1}→${version}`)) missing.push(`${version - 1}→${version}`);
    }
    expect(
      missing,
      `${ARCH_REL}: the Schema Versions migrator list for \`STATE_SCHEMA_VERSION\` ` +
        `(now \`${STATE_SCHEMA_VERSION}\`) is missing ${missing.join(', ')}. ` +
        'A migrator that ran but is undocumented is how a reader concludes their ' +
        'workspace needs no migration when it does.'
    ).toEqual([]);

    // The mirror failure: a documented step past the constant means either the
    // bump was reverted or the row was written ahead of the code.
    const beyond = steps.filter((step) => step.to > STATE_SCHEMA_VERSION);
    expect(
      beyond.map((step) => `${step.from}→${step.to}`),
      `${ARCH_REL}: the migrator list documents a step above ` +
        `\`STATE_SCHEMA_VERSION\` = \`${STATE_SCHEMA_VERSION}\`.`
    ).toEqual([]);
  });

  it('no mention of a schema version anywhere in the document disagrees with its constant', () => {
    // The self-contradiction case: `STATE_SCHEMA_VERSION = 11` in the State
    // subsystem prose while the table said `10`. Neither of the two assertions
    // above sees it, because each looks at one place.
    const wrong = disagreements(ARCH_LINES);
    expect(
      wrong,
      `${ARCH_REL} contradicts a schema constant:\n${wrong.join('\n')}`
    ).toEqual([]);
  });

  it('NON-VACUITY: a drifted schema version in the document is detected', () => {
    // FR-R3-102 (FR-034). This gate had no non-vacuity control, and that mattered more
    // than usual: it is the reason `repo/ARCHITECTURE.md` could be trusted as the
    // surviving authority when the envelope document was demoted (FR-032). A
    // machine-pinned document whose pin has never been observed failing is
    // machine-pinned in name only.
    //
    // The mutation runs the REAL detector over the REAL document text with one number
    // changed, in memory. Nothing is written, and the detector is the same function the
    // assertion above uses — a hand-written stub would only prove that a regex matches
    // a string written to be matched.
    const target = ARCH_LINES.findIndex(
      (line) => line.includes('STATE_SCHEMA_VERSION') && /`\d+`/.test(line)
    );
    expect(
      target,
      'no line in the document both names STATE_SCHEMA_VERSION and states a number, so ' +
        'the assertion above has nothing to check and this gate is vacuous'
    ).toBeGreaterThanOrEqual(0);

    const mutated = [...ARCH_LINES];
    mutated[target] = (mutated[target] as string).replace(
      /`\d+`/,
      `\`${STATE_SCHEMA_VERSION + 41}\``
    );
    expect(mutated[target], 'the mutation changed nothing, so it proves nothing').not.toBe(
      ARCH_LINES[target]
    );

    const found = disagreements(mutated);
    expect(
      found.length,
      'the detector did not notice a schema version it was pointed straight at'
    ).toBeGreaterThan(0);
    expect(found.join('\n')).toContain('STATE_SCHEMA_VERSION');
    // ...and the unmutated document is clean, so the detector is not matching everything.
    expect(disagreements(ARCH_LINES)).toEqual([]);
  });

  /**
   * FR-R3-145 (T1570) — this pair used to check the document against
   * `package.json`. There is no contribution to check against any more.
   *
   * `schegent.queue.globalConcurrencyCap` was a *configuration* key, and it was
   * removed because no scheduling path read it: `hasExecutionCapacity` and
   * `hasWorkspaceCapacity` gate on the workspace memento of the same name, which
   * the Queue configuration surface writes through `CMD_SAVE_QUEUE_SETTINGS`. A
   * three-way parity check whose third leg is a key nothing consults was
   * verifying that two stale numbers agreed.
   *
   * What replaces it is the same check with the manifest leg turned around: the
   * document is pinned to the constants, and the contribution's ABSENCE is
   * asserted. Restoring the key would fail here, which is the point — the reason
   * it is gone is not obvious from `package.json`, where nothing is written.
   */
  it('no manifest contribution restates the cap', () => {
    expect(
      contributionOrNull('schegent.queue.globalConcurrencyCap'),
      'package.json contributes `schegent.queue.globalConcurrencyCap` again. That key ' +
        'was removed by FR-R3-145: the cap the drain gates on lives in the workspace ' +
        'memento of the same name, and a configuration key beside it is a second ' +
        'opinion the operator can set and nothing reads. If the intent is to make the ' +
        'cap configurable, the work is to make the scheduler read configuration — not ' +
        'to re-advertise the key.'
    ).toBeNull();
  });

  it('the documented globalConcurrencyCap default matches the code', () => {
    const documented = claimNear('schegent.queue.globalConcurrencyCap', /default `(\d+)`/);
    expect(
      documented,
      `${ARCH_REL} names \`schegent.queue.globalConcurrencyCap\` without stating its ` +
        'default in the form "default `N`" nearby; this guard reads that claim'
    ).toBeTruthy();
    expect(
      Number((documented as RegExpMatchArray)[1]),
      `${ARCH_REL} documents a default of ${(documented as RegExpMatchArray)[1]} for ` +
        `\`schegent.queue.globalConcurrencyCap\`; the shipped default is ` +
        `\`${DEFAULT_GLOBAL_CONCURRENCY_CAP}\`, from ` +
        '`src/contracts/queue-bounds.ts`. The 2026-08-18 defaults change lowered it ' +
        'under review finding REL-02 — not feature 098, which is the runtime-only ' +
        `catalog. Edit ${ARCH_REL}.`
    ).toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);
  });

  it('the documented globalConcurrencyCap range matches the enforced bounds', () => {
    const documented = claimNear(
      'schegent.queue.globalConcurrencyCap',
      /range `\[(\d+), (\d+)\]`/
    );
    expect(
      documented,
      `${ARCH_REL} names \`schegent.queue.globalConcurrencyCap\` without stating its ` +
        'range in the form "range `[min, max]`" nearby'
    ).toBeTruthy();
    const [, min, max] = documented as RegExpMatchArray;
    expect(
      [Number(min), Number(max)],
      `${ARCH_REL} documents the range [${min}, ${max}] for ` +
        `\`schegent.queue.globalConcurrencyCap\`; the bound enforced by ` +
        '`WorkspaceStateStore`, `QueueManager.saveQueueSettings` and ' +
        `\`validateSaveQueueSettings\` is [1, ${MAX_GLOBAL_CONCURRENCY_CAP}].`
    ).toEqual([1, MAX_GLOBAL_CONCURRENCY_CAP]);
  });

  it('the documented MAX_QUEUES bound matches the constant', () => {
    const documented = FLAT.match(/`MAX_QUEUES = (\d+)`/);
    expect(
      documented,
      `${ARCH_REL} no longer states \`MAX_QUEUES = N\`; this guard reads that claim`
    ).toBeTruthy();
    expect(
      Number((documented as RegExpMatchArray)[1]),
      `${ARCH_REL} documents \`MAX_QUEUES = ${(documented as RegExpMatchArray)[1]}\`; ` +
        `src/queue/queue-registry.ts says \`${MAX_QUEUES}\`. Raising it requires a state ` +
        'migration and a scheduler design (CLAUDE.md hard rule), so a bare doc edit here ' +
        'is the wrong fix if the code moved.'
    ).toBe(MAX_QUEUES);
  });
});
