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
import { MAX_QUEUES } from '../../src/queue/queue-registry';
import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../src/state/workspace-state';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARCH_REL = 'ARCHITECTURE.md';
const ARCH = fs.readFileSync(path.join(REPO_ROOT, ARCH_REL), 'utf8');
const ARCH_LINES = ARCH.split('\n');

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
    const wrong: string[] = [];
    for (const [name, value] of VERSION_CONSTANTS) {
      const assignment = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'g');
      ARCH_LINES.forEach((line, index) => {
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
    expect(
      wrong,
      `${ARCH_REL} contradicts a schema constant:\n${wrong.join('\n')}`
    ).toEqual([]);
  });

  it('the documented globalConcurrencyCap default matches the code and the contribution', () => {
    const contribution = readContribution('schegent.queue.globalConcurrencyCap');
    // Three-way, and the code-to-contribution leg first: if those two have
    // already drifted, the document cannot be right about both and saying which
    // one it disagrees with would be arbitrary.
    expect(
      contribution.default,
      'package.json contributes a different default for ' +
        '`schegent.queue.globalConcurrencyCap` than `DEFAULT_GLOBAL_CONCURRENCY_CAP` ' +
        'in src/state/workspace-state.ts'
    ).toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);

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
        `\`${DEFAULT_GLOBAL_CONCURRENCY_CAP}\`. Feature 098 (REL-02) lowered it. ` +
        `Edit ${ARCH_REL}.`
    ).toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);
  });

  it('the documented globalConcurrencyCap range matches the contribution', () => {
    const contribution = readContribution('schegent.queue.globalConcurrencyCap');
    const documented = claimNear('schegent.queue.globalConcurrencyCap', /range `\[(\d+), (\d+)\]`/);
    expect(
      documented,
      `${ARCH_REL} names \`schegent.queue.globalConcurrencyCap\` without stating its ` +
        'range in the form "range `[min, max]`" nearby'
    ).toBeTruthy();
    const [, min, max] = documented as RegExpMatchArray;
    expect(
      [Number(min), Number(max)],
      `${ARCH_REL} documents the range [${min}, ${max}] for ` +
        `\`schegent.queue.globalConcurrencyCap\`; package.json contributes ` +
        `[${contribution.minimum}, ${contribution.maximum}].`
    ).toEqual([contribution.minimum, contribution.maximum]);
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
