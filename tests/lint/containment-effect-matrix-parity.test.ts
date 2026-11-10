// FR-R6-F09 T013 (FR-015, F09-AC-01) -- section 10 of the qualification record and
// `EVIDENCE_MATRIX` list the same per-effect evidence, in both directions.
//
// WHY. The matrix is what the spawn gate, the sidebar and the headless inspection decide from;
// section 10 is what an operator reads before accepting a backend. A row in code the record does
// not show is evidence the operator never saw; a row in the record the code does not carry is a
// claim nothing acts on. Either is drift on the document that answers "is this agent bounded".
//
// WHAT IT DOES NOT CHECK. Whether an observed row is true: that needs a live probe, and section 1
// of the record states the limit. This gate checks that the record and the code say the same thing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANY, EVIDENCE_MATRIX } from '../../src/services/containment-qualification/evidence-matrix';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD_PATH = 'docs/architecture/backend-containment-qualification.md';
const SECTION_HEADING = '\n## 10. Per-effect qualification matrix';

/** `| `backend` | os/arch | version | `effect` | `outcome` | `basis` |` */
const ROW = /^\|\s*`([a-z]+)`\s*\|\s*([a-z0-9*]+)\/([a-z0-9*]+)\s*\|\s*([0-9.]+|any)\s*\|\s*`([a-z-]+)`\s*\|\s*`([a-z-]+)`\s*\|\s*`([a-z-]+)`\s*\|\s*$/gm;

function sectionText(): string {
  const body = readFileSync(resolve(REPO_ROOT, RECORD_PATH), 'utf8');
  const start = body.indexOf(SECTION_HEADING);
  if (start === -1) return '';
  const next = body.indexOf('\n## ', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}

function shown(column: string): string {
  return column === ANY ? 'any' : column;
}

function recordedRows(): string[] {
  return [...sectionText().matchAll(ROW)].map((match) => match.slice(1).join(' | '));
}

function codeRows(): string[] {
  return EVIDENCE_MATRIX.map((row) =>
    [row.backend, shown(row.os), shown(row.arch), shown(row.versionMinor), row.effect, row.outcome, row.basis].join(' | ')
  );
}

function missingFrom(source: readonly string[], target: readonly string[]): string[] {
  const remaining = [...target];
  const missing: string[] = [];
  for (const entry of source) {
    const index = remaining.indexOf(entry);
    if (index === -1) missing.push(entry);
    else remaining.splice(index, 1);
  }
  return missing;
}

describe('FR-R6-F09 -- section 10 and EVIDENCE_MATRIX agree', () => {
  const recorded = recordedRows();
  const code = codeRows();

  it('parses the section (vacuity control)', () => {
    expect(sectionText(), `${RECORD_PATH} has no section 10 heading`).not.toBe('');
    expect(
      recorded.length,
      'no rows parsed out of section 10 -- the table changed shape and this gate compares nothing'
    ).toBeGreaterThanOrEqual(EVIDENCE_MATRIX.length);
  });

  it('shows every matrix row in the record', () => {
    expect(
      missingFrom(code, recorded),
      `EVIDENCE_MATRIX rows absent from section 10 of ${RECORD_PATH}: evidence the operator never saw`
    ).toEqual([]);
  });

  it('claims no row the matrix does not carry -- the worse direction', () => {
    expect(
      missingFrom(recorded, code),
      `section 10 rows with no EVIDENCE_MATRIX entry: a claim nothing in the product acts on`
    ).toEqual([]);
  });

  it('a control row that is not in the matrix is reported missing', () => {
    expect(missingFrom(['codex | linux | x64 | 9.9 | fs-write | observed-enforced | observed-behavior'], code)).toHaveLength(1);
  });
});
