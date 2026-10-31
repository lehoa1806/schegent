// FR-R3-125 (FR-003) — the qualification record and the product name the same
// containment mechanism, for every backend, in both directions.
//
// WHY THIS EXISTS. `docs/architecture/backend-containment-qualification.md` is what
// an operator reads before accepting that a backend has no OS-enforced bound. A
// record that cannot be checked against the product is a record that drifts, and
// this round has closed five instances of exactly that: `FR-R3-116` (a mechanism
// the documents denied), `122` (three records that were not true), `123` (58
// statuses that were not true), `126` (a security default the threat model states
// backwards), `124` (a `git worktree` ban whose prescribed home never held it).
// A sixth, on the document that answers "is this agent bounded", is not acceptable.
//
// BOTH DIRECTIONS, and the second is the worse failure:
//
//   - a mechanism in code that the record does not name is an UNDECLARED boundary:
//     the product does something the operator was never told about;
//   - a mechanism the record names that the code does not carry is a FALSE CLAIM:
//     the operator was told about a boundary that is not there.
//
// `check-gate-coverage-parity.mjs` makes the same argument for its own two
// directions, and names the same asymmetry.
//
// WHAT IT DOES NOT CHECK. Whether a named mechanism actually enforces anything.
// That is a claim about an operating system, it needs a live probe, and §1 of the
// record states the limit of the evidence available without one. This gate checks
// that the product and the record agree about WHAT IS CLAIMED — not that the claim
// is true.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  mechanismByBackend,
  type BackendContainmentMechanism
} from '../../src/services/backend-containment-policy';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import { CONFIRMED_FLAGS } from '../../src/services/capability-confirmed-flags';
import { planCapabilityEnforcement } from '../../src/services/capability-enforcement-plan';
import {
  ALL_PHASE_CAPABILITIES,
  declaredCapabilitySet,
  type PhaseCapability
} from '../../src/contracts/phase-capabilities';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD_PATH = 'docs/architecture/backend-containment-qualification.md';

/** The record's matrix rows: `| backend | platform | … | mechanism | verified how |`. */
const ROW = /^\|\s*`([a-z]+)`\s*\|\s*([a-z0-9 /]+?)\s*\|.*?\|\s*`([a-z-]+)`\s*\|/gm;

interface RecordedCell {
  readonly backend: string;
  readonly platform: string;
  readonly mechanism: string;
}

/**
 * The text of one `## ` section, from its heading to the next `## ` heading (or the end).
 *
 * FR-R4-F06 (L9; Q4) -- sections 7 and 8 are tables whose rows also begin with a backtick-quoted
 * backend name, so the mechanism-row regex above would read them as mechanism rows. The mechanism
 * matrix is section 3 and only section 3; every other table is read by its own function below.
 */
function sectionOf(body: string, headingPrefix: string): string {
  const start = body.indexOf(`\n## ${headingPrefix}`);
  if (start === -1) return '';
  const next = body.indexOf('\n## ', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}

function recordedCells(): readonly RecordedCell[] {
  const body = sectionOf(readFileSync(resolve(REPO_ROOT, RECORD_PATH), 'utf8'), '3.');
  const cells: RecordedCell[] = [];
  for (const match of body.matchAll(ROW)) {
    cells.push({ backend: match[1]!, platform: match[2]!, mechanism: match[3]! });
  }
  return cells;
}

describe('the containment qualification record agrees with the product (FR-R3-125)', () => {
  const cells = recordedCells();
  const code = mechanismByBackend();

  it('parses a matrix with a row for every backend', () => {
    // Vacuity control. Every assertion below compares two sets and would pass over
    // an empty parse — a reformatted table, a renamed heading, a moved file. The
    // floor is per-backend rather than a literal row count, so adding platform rows
    // does not require editing this number.
    expect(
      cells.length,
      `no matrix rows parsed out of ${RECORD_PATH} — the table's shape changed and this gate is ` +
        'comparing nothing to nothing'
    ).toBeGreaterThanOrEqual(SUPPORTED_BACKENDS.length);
    const covered = new Set(cells.map((cell) => cell.backend));
    expect(
      SUPPORTED_BACKENDS.filter((kind: BackendRunnerKind) => !covered.has(kind)),
      'these backends have no row in the qualification record. An operator deciding whether to ' +
        'accept an unbounded agent for one of them has nothing to read.'
    ).toEqual([]);
  });

  it('names, for every backend, the mechanism the code carries', () => {
    // Direction 1: an undeclared boundary. The product does something the record
    // does not mention.
    const disagreements: string[] = [];
    for (const [kind, mechanism] of code) {
      const rows = cells.filter((cell) => cell.backend === kind);
      for (const row of rows) {
        if (row.mechanism !== mechanism) {
          disagreements.push(
            `${kind} (${row.platform}): record says '${row.mechanism}', code says '${mechanism}'`
          );
        }
      }
    }
    expect(
      disagreements,
      `${RECORD_PATH} and src/services/backend-containment-policy.ts disagree. Whichever is ` +
        'wrong, fix that one — do not adjust this gate. If a backend genuinely gained or lost a ' +
        'boundary, the record needs the evidence for it (§1 of the record states what counts).'
    ).toEqual([]);
  });

  it('names no mechanism the code does not carry — the worse direction', () => {
    // Direction 2: a false claim. The operator was told about a boundary that is
    // not in the product. `check-gate-coverage-parity.mjs` calls this out as the
    // worse of its own two directions for the same reason.
    const known = new Set<string>(code.values());
    const invented = cells
      .filter((cell) => !known.has(cell.mechanism))
      .map((cell) => `${cell.backend} (${cell.platform}): '${cell.mechanism}'`);
    expect(
      invented,
      `${RECORD_PATH} names containment mechanisms the product does not implement. This is the ` +
        'direction that misleads an operator into trusting a boundary that is not there.'
    ).toEqual([]);
  });

  it('records the uncontained backends as uncontained, explicitly', () => {
    // `none` is a value, not an omission. A row that simply left the column empty
    // would read as "not assessed", which is the distinction this whole feature
    // is about.
    const uncontained = [...code].filter(([, mechanism]) => mechanism === 'none');
    expect(uncontained.length, 'the sweep must find uncontained backends').toBeGreaterThan(0);
    for (const [kind] of uncontained) {
      const rows = cells.filter((cell) => cell.backend === kind);
      expect(rows.length, `${kind} has no row`).toBeGreaterThan(0);
      for (const row of rows) expect(row.mechanism, `${kind} (${row.platform})`).toBe('none');
    }
  });

  it('carries the Agy finding, with its probe and its entry condition', () => {
    // FR-R3-125's substantive finding: `agy` exposes `--sandbox` and Schegent does
    // not request it. The decision not to request it is only defensible while the
    // reasoning, the probe and the entry condition are on the record — otherwise
    // it degrades into an unexplained omission, which is what a later reader will
    // reasonably "fix".
    const body = readFileSync(resolve(REPO_ROOT, RECORD_PATH), 'utf8');
    expect(body).toContain('--sandbox');
    expect(body).toMatch(/probe that would qualify it/i);
    expect(body).toMatch(/entry condition/i);
  });

  it('is red on a wrong row and green on the real one — proved, not assumed', () => {
    // FR-004a's shape for this gate. Every assertion above is "the disagreement
    // list is empty", and the way that fails silently is a parse that finds
    // nothing or a comparison that cannot differ. Both directions are driven
    // against the real code table with a fabricated record row.
    const known = new Set<string>(code.values());
    const wrongForCodex: RecordedCell = {
      backend: 'codex',
      platform: 'darwin',
      mechanism: 'none'
    };
    const inventedMechanism: RecordedCell = {
      backend: 'agy',
      platform: 'darwin',
      mechanism: 'agy-sandbox-terminal-restrictions'
    };

    const codexMechanism = code.get('codex');
    expect(codexMechanism, 'codex must be in the code table').toBeDefined();
    expect(
      wrongForCodex.mechanism !== codexMechanism,
      'direction 1 must be able to detect a record row that contradicts the code'
    ).toBe(true);
    expect(
      known.has(inventedMechanism.mechanism),
      'direction 2 must be able to detect a mechanism the code does not implement'
    ).toBe(false);

    // And the real rows must pass both, so the fixture is not proving the gate
    // rejects everything.
    for (const cell of cells) {
      expect(known.has(cell.mechanism), `real row ${cell.backend}/${cell.platform}`).toBe(true);
    }
  });
});

describe('the setting only offers the backends it can grant (FR-R3-125)', () => {
  it("the manifest's enum is exactly the uncontained backends", () => {
    // Two silent failures this closes, in opposite directions:
    //
    //   - a FOURTH uncontained backend is added and the enum is not, so VS Code
    //     refuses the only value that would let an operator run it, and the
    //     refusal reads as a product bug rather than a manifest omission;
    //   - a backend gains a real boundary and stays in the enum, so the settings
    //     UI keeps offering a grant that `resolveUncontainedGrant` now reports as
    //     granting nothing.
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { items?: { enum?: readonly string[] } }>;
        };
      };
    };
    const offered =
      manifest.contributes?.configuration?.properties?.['schegent.backend.uncontainedBackends']
        ?.items?.enum;
    expect(offered, 'the setting must declare an item enum').toBeDefined();
    const uncontained = [...mechanismByBackend()]
      .filter(([, mechanism]) => mechanism === 'none')
      .map(([kind]) => kind)
      .sort();
    expect([...(offered as readonly string[])].sort()).toEqual(uncontained);
    expect(uncontained.length, 'the sweep must find uncontained backends').toBeGreaterThan(0);
  });
});

describe('the mechanism union stays closed (FR-R3-125)', () => {
  it('has no mechanism outside the declared union', () => {
    const allowed: readonly BackendContainmentMechanism[] = [
      'codex-sandbox-workspace-write',
      'none'
    ];
    for (const [kind, mechanism] of mechanismByBackend()) {
      expect(allowed, `${kind} carries an undeclared mechanism`).toContain(mechanism);
    }
    // A closed union with nothing in it would satisfy the loop above vacuously.
    expect(allowed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FR-R4-F06 (FR-028, FR-029, FR-033; L9; contract Q, Q1, Q2 and Q4) -- sections 7 and 8
// ---------------------------------------------------------------------------
//
// Section 7 is the capability-semantics matrix and section 8 the platform matrix. Both state, per row,
// what was OBSERVED, and the point of this gate is that the word cannot be written unearned: a
// section 7 row is `observed` exactly when its flag is in `CONFIRMED_FLAGS` (the transcription of the
// offline help capture), and a row for a flag that was not confirmed is never `observed`. The
// section 7 enforcement class and residuals are checked against the planner by the capability gate
// (T140), not here.

const STATUSES = ['observed', 'unsupported', 'unobserved'] as const;
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const CAPTURED_PLATFORM = 'darwin';
/** What an `observed` row may never rest on (FR-033). */
const SIMULATED = /\b(stub|fake|simulat\w*|mock\w*)\b/i;

function tableRows(section: string): string[][] {
  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|?$/.test(line))
    .map((line) => line.slice(1, line.lastIndexOf('|')).split('|').map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== 'Backend' && cells[0] !== 'Topic');
}

/**
 * A table row as eight named cells, each a string. `.at()` rather than an index, so a row shorter than eight
 * reads as empty cells and not as `undefined` (the tree is held to `noUncheckedIndexedAccess` by a ratchet,
 * and a destructured array element would add to its count).
 */
type Row8 = readonly [string, string, string, string, string, string, string, string];
const rowOf = (cells: readonly string[]): Row8 =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((index) => cells.at(index) ?? '') as unknown as Row8;

describe('sections 7 and 8 state only what was observed (L9, FR-R4-F06)', () => {
  const body = readFileSync(resolve(REPO_ROOT, RECORD_PATH), 'utf8');
  const capability = tableRows(sectionOf(body, '7.')).map(rowOf);
  const platform = tableRows(sectionOf(body, '8.'))
    .filter((cells) => cells.length === 5)
    .map(rowOf);

  it('parses the twelve capability rows and a platform row for every topic and platform', () => {
    // Vacuity control: a reformatted table would parse to nothing and every check below would pass.
    expect(capability, 'section 7 holds one row per backend x withheld capability').toHaveLength(12);
    const topics = new Set(platform.map((cells) => cells[0]));
    expect(topics.size).toBeGreaterThanOrEqual(7);
    expect(platform).toHaveLength(topics.size * PLATFORMS.length);
  });

  it('gives every section 7 row a known backend, a flag or none, and a status from the closed set', () => {
    for (const cells of capability) {
      const [backend, , flag, , , , status] = cells;
      const kind = backend.replace(/`/g, '') as BackendRunnerKind;
      expect(SUPPORTED_BACKENDS, `unknown backend ${backend}`).toContain(kind);
      expect(flag, `${backend}: the flag cell is empty`).toBeTruthy();
      expect(STATUSES as readonly string[], `${backend} ${cells[1]}: status '${status}'`).toContain(status);
    }
  });

  it('marks a section 7 row observed exactly when its flag is in CONFIRMED_FLAGS', () => {
    const wrong: string[] = [];
    for (const cells of capability) {
      const [backend, withheld, flagCell, , , , status] = cells;
      const kind = backend.replace(/`/g, '') as BackendRunnerKind;
      const flagName = /--[A-Za-z][\w-]*/.exec(flagCell)?.[0];
      const confirmed = flagName !== undefined && CONFIRMED_FLAGS[kind].includes(flagName);
      if (confirmed && status !== 'observed') wrong.push(`${kind} ${withheld}: ${flagName} is confirmed but the row says '${status}'`);
      if (!confirmed && status === 'observed') wrong.push(`${kind} ${withheld}: the row says observed but ${flagName ?? 'no flag'} is not confirmed`);
    }
    expect(wrong, 'a row says what the capture did not show, or hides what it did').toEqual([]);
  });

  it('confirms no flag that no row names, and every confirmed flag appears in section 7', () => {
    const named = new Set<string>();
    for (const cells of capability) {
      const kind = cells[0].replace(/`/g, '') as BackendRunnerKind;
      const flagName = /--[A-Za-z][\w-]*/.exec(cells[2])?.[0];
      if (flagName !== undefined) named.add(`${kind}:${flagName}`);
    }
    const unreferenced: string[] = [];
    for (const kind of SUPPORTED_BACKENDS) {
      for (const flag of CONFIRMED_FLAGS[kind]) {
        // `--dangerously-skip-permissions` is the unrestricted argv, not a withholding flag, so no
        // section 7 row names it; every other confirmed flag must be some row's.
        if (flag === '--dangerously-skip-permissions') continue;
        if (!named.has(`${kind}:${flag}`)) unreferenced.push(`${kind} ${flag}`);
      }
    }
    expect(unreferenced).toEqual([]);
  });

  it('gives every section 8 row a known platform and status, and observes only the cycle host\'s', () => {
    const wrong: string[] = [];
    for (const [topic, platformName, status, versions, evidence] of platform) {
      if (!(PLATFORMS as readonly string[]).includes(platformName)) wrong.push(`${topic}: platform '${platformName}'`);
      if (!(STATUSES as readonly string[]).includes(status)) wrong.push(`${topic} (${platformName}): status '${status}'`);
      if (status === 'observed' && platformName !== CAPTURED_PLATFORM) {
        wrong.push(`${topic} (${platformName}): observed on a platform this record was not taken on`);
      }
      if (status !== 'observed' && !evidence) wrong.push(`${topic} (${platformName}): no prerequisite or source`);
      if (status === 'observed' && !versions) wrong.push(`${topic} (${platformName}): observed with no version cell`);
    }
    expect(wrong).toEqual([]);
  });

  it('rests no observed row on a stub, a fake or a simulation (FR-033)', () => {
    const wrong = [
      ...capability.filter((cells) => cells[6] === 'observed' && SIMULATED.test(cells[5])),
      ...platform.filter((cells) => cells[2] === 'observed' && SIMULATED.test(cells[4]))
    ].map((cells) => cells.slice(0, 2).join(' '));
    expect(wrong).toEqual([]);
  });

  it('states, for every section 7 row, the enforcement class and residuals the planner declares (Q4)', () => {
    // The declaration for one capability is the planner's cell for the set that withholds exactly that
    // capability and grants the rest: the shell-reaching residuals hold while `process-spawn` is granted,
    // which is the case this table describes. A capability the planner declares nothing for is a refusal.
    const wrong: string[] = [];
    for (const cells of capability) {
      const [backend, withheldCell, , enforcementCell, residualsCell] = cells;
      const kind = backend.replace(/`/g, '') as BackendRunnerKind;
      const withheld = withheldCell.replace(/`/g, '') as PhaseCapability;
      expect(ALL_PHASE_CAPABILITIES, `unknown capability ${withheld}`).toContain(withheld);
      const granted = ALL_PHASE_CAPABILITIES.filter((candidate) => candidate !== withheld);
      const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(granted));

      const recordedClass = enforcementCell.replace(/`/g, '');
      const recordedResiduals = [...residualsCell.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!).sort();
      if (plan.outcome === 'refused') {
        if (recordedClass !== 'refused') wrong.push(`${kind} ${withheld}: the planner refuses it, the record says '${recordedClass}'`);
        if (recordedResiduals.length > 0) wrong.push(`${kind} ${withheld}: a refusal has no residuals, the record lists ${recordedResiduals.join(', ')}`);
        continue;
      }
      if (recordedClass !== plan.enforcement) {
        wrong.push(`${kind} ${withheld}: class '${recordedClass}', planner '${plan.enforcement}'`);
      }
      if (JSON.stringify(recordedResiduals) !== JSON.stringify([...plan.residuals].sort())) {
        wrong.push(`${kind} ${withheld}: residuals [${recordedResiduals.join(', ')}], planner [${plan.residuals.join(', ')}]`);
      }
    }
    expect(wrong, 'section 7 and the planner disagree about what a restriction enforces and leaves open').toEqual([]);
  });

  it('is seeded: a section 7 residual the planner does not declare is caught', () => {
    const planted = capability.map((cells) =>
      cells[0] === '`claude`' && cells[1] === '`network`'
        ? rowOf([...cells.slice(0, 4), '`unlisted-tools`', ...cells.slice(5)])
        : cells
    );
    const row = planted.find((cells) => cells[0] === '`claude`' && cells[1] === '`network`');
    if (row === undefined) throw new Error('the seeded row is missing');
    const granted = ALL_PHASE_CAPABILITIES.filter((candidate) => candidate !== 'network');
    const plan = planCapabilityEnforcement('claude', declaredCapabilitySet(granted));
    const recorded = [...row[4].matchAll(/`([a-z-]+)`/g)].map((m) => m.at(1) ?? '').sort();
    expect(plan.outcome === 'argv' && JSON.stringify(recorded) !== JSON.stringify([...plan.residuals].sort())).toBe(true);
  });

  it('states the executable-identity decision and the remote limit', () => {
    expect(body).toMatch(/A version is not an identity/);
    expect(body).toMatch(/not adopted/i);
    expect(body).toMatch(/Remote development is unqualified/);
  });

  it('is seeded: a section 7 row marked observed for an unconfirmed flag is caught', () => {
    // The check above is only worth having if it can fail. Planting the defect in a copy of the
    // table and re-running the same rule shows it does.
    const planted = capability.map((cells) =>
      cells[0] === '`codex`' && cells[1] === '`network`'
        ? rowOf([...cells.slice(0, 6), 'observed', ...cells.slice(7)])
        : cells
    );
    const wrong = planted.filter((cells) => {
      const kind = cells[0].replace(/`/g, '') as BackendRunnerKind;
      const flagName = /--[A-Za-z][\w-]*/.exec(cells[2])?.[0];
      const confirmed = flagName !== undefined && CONFIRMED_FLAGS[kind].includes(flagName);
      return !confirmed && cells[6] === 'observed';
    });
    expect(wrong).toHaveLength(1);
  });
});
