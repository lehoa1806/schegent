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

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD_PATH = 'docs/architecture/backend-containment-qualification.md';

/** The record's matrix rows: `| backend | platform | … | mechanism | verified how |`. */
const ROW = /^\|\s*`([a-z]+)`\s*\|\s*([a-z0-9 /]+?)\s*\|.*?\|\s*`([a-z-]+)`\s*\|/gm;

interface RecordedCell {
  readonly backend: string;
  readonly platform: string;
  readonly mechanism: string;
}

function recordedCells(): readonly RecordedCell[] {
  const body = readFileSync(resolve(REPO_ROOT, RECORD_PATH), 'utf8');
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
