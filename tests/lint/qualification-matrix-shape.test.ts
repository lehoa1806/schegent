import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-033, SC-011; research R24; data-model section 12; contract L6) -- the
 * qualification matrix never says a platform passed without saying what was observed.
 *
 * THE DEFECT IT PREVENTS. `RELEASE.md` and the gate record both read as if "the gate passes" were a
 * property of the extension. It is a property of one run on one machine: a gate record names the
 * platform, the Node and the commit it ran at, and says nothing about the five other combinations
 * the extension declares it supports. A table with six cells, Node 22 and 24 by macOS, Linux and
 * Windows, makes that visible, and this gate keeps it honest: each cell is either OBSERVED, with the
 * five facts an observation has (the command, the full runtime version, a commit of at least seven
 * hex digits, an exit code and a date), or `unobserved`, with the prerequisite someone would need
 * to observe it. There is no third shape. A cell that says "passed" and lacks any of the five is
 * reported by name.
 *
 * Hermetic: `readFileSync` and a pure parser. The parser and the rule are also run over planted
 * rows, which is the control that shows the real page passing is a measurement.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'docs/release/qualification-matrix.md');
const CONTRIBUTING = resolve(REPO_ROOT, 'CONTRIBUTING.md');

const OSES = ['macOS', 'Linux', 'Windows'] as const;
const NODES = ['22', '24'] as const;
const NONE = '—';

interface Cell {
  readonly os: string;
  readonly node: string;
  readonly state: string;
  readonly command: string;
  readonly runtime: string;
  readonly commit: string;
  readonly outcome: string;
  readonly date: string;
  readonly prerequisite: string;
}

const COLUMNS = ['os', 'node', 'state', 'command', 'runtime', 'commit', 'outcome', 'date', 'prerequisite'] as const;

/** Every data row of every table whose header names the nine columns, in order. */
function parseCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let inMatrix = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      inMatrix = false;
      continue;
    }
    const parts = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((part) => part.trim().replaceAll('`', ''));
    if (parts.length === COLUMNS.length && parts.at(0) === 'OS' && parts.at(2) === 'State') {
      inMatrix = true;
      continue;
    }
    if (!inMatrix || parts.length !== COLUMNS.length || /^-+$/.test(parts.at(0) ?? '')) continue;
    cells.push(Object.fromEntries(COLUMNS.map((name, index) => [name, parts.at(index) ?? ''])) as unknown as Cell);
  }
  return cells;
}

/** What is wrong with one cell, by name. Empty means the cell has one of the two valid shapes. */
function violations(cell: Cell): string[] {
  const where = `${cell.os} / Node ${cell.node}`;
  if (cell.state === 'unobserved') {
    const problems: string[] = [];
    if (cell.prerequisite === '' || cell.prerequisite === NONE) {
      problems.push(`${where}: unobserved with no prerequisite`);
    }
    for (const name of ['command', 'runtime', 'commit', 'outcome', 'date'] as const) {
      if (cell[name] !== NONE) problems.push(`${where}: unobserved but carries a ${name}`);
    }
    return problems;
  }
  if (cell.state !== 'observed') {
    return [`${where}: state ${JSON.stringify(cell.state)} is neither observed nor unobserved`];
  }
  const problems: string[] = [];
  if (cell.command === '' || cell.command === NONE) problems.push(`${where}: observed with no command`);
  if (!/^v\d+\.\d+\.\d+$/.test(cell.runtime)) problems.push(`${where}: observed with no full runtime version`);
  if (!/^[0-9a-f]{7,40}$/.test(cell.commit)) problems.push(`${where}: observed with no commit of at least 7 hex`);
  if (!/^exit \d+$/.test(cell.outcome)) problems.push(`${where}: observed with no exit code`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell.date)) problems.push(`${where}: observed with no YYYY-MM-DD date`);
  return problems;
}

describe('FR-R4-F09 — every qualification matrix cell is observed with five facts or unobserved with a prerequisite: the real page', () => {
  it('exists', () => {
    expect(existsSync(MATRIX_PATH), 'docs/release/qualification-matrix.md must exist').toBe(true);
  });

  const cells = existsSync(MATRIX_PATH) ? parseCells(readFileSync(MATRIX_PATH, 'utf8')) : [];

  it('has exactly the six cells: Node 22 and 24 on macOS, Linux and Windows', () => {
    const present = cells.map((cell) => `${cell.os}/${cell.node}`).sort();
    const expected = OSES.flatMap((os) => NODES.map((node) => `${os}/${node}`)).sort();
    expect(present).toEqual(expected);
  });

  it('gives every cell one of the two valid shapes', () => {
    expect(cells.flatMap(violations)).toEqual([]);
  });

  it('CONTROL: observes nothing it cannot cite, and leaves at least one cell honestly unobserved', () => {
    expect(cells.some((cell) => cell.state === 'unobserved')).toBe(true);
    expect(cells.filter((cell) => cell.state === 'observed').length).toBeLessThan(cells.length);
  });

  it('links the Node 24 crash note and says a newer patch is not evidence of a fix', () => {
    const text = existsSync(MATRIX_PATH) ? readFileSync(MATRIX_PATH, 'utf8') : '';
    expect(text).toContain('CONTRIBUTING.md');
    expect(text).toContain('Segmentation fault: 11');
    expect(text).toMatch(/not evidence of a fix/i);
    expect(readFileSync(CONTRIBUTING, 'utf8')).toContain('Segmentation fault: 11');
  });
});

describe('NON-VACUITY: planted cells are reported', () => {
  const row = (...parts: string[]) => `| ${parts.join(' | ')} |`;
  const header = row('OS', 'Node', 'State', 'Command', 'Runtime', 'Commit', 'Outcome', 'Date', 'Prerequisite');
  const table = (...rows: string[]) => [header, row(...Array(9).fill('---')), ...rows].join('\n');
  const found = (...rows: string[]) => parseCells(table(...rows)).flatMap(violations);

  it('reports a passed cell with none of the five facts', () => {
    expect(found(row('macOS', '22', 'passed', NONE, NONE, NONE, NONE, NONE, NONE))).toEqual([
      'macOS / Node 22: state "passed" is neither observed nor unobserved'
    ]);
  });

  it.each([
    ['command', row('Linux', '24', 'observed', NONE, 'v24.21.0', 'abcdef0', 'exit 0', '2026-10-22', NONE)],
    ['runtime', row('Linux', '24', 'observed', 'npm run gate', '24', 'abcdef0', 'exit 0', '2026-10-22', NONE)],
    ['commit', row('Linux', '24', 'observed', 'npm run gate', 'v24.21.0', 'abc', 'exit 0', '2026-10-22', NONE)],
    ['exit code', row('Linux', '24', 'observed', 'npm run gate', 'v24.21.0', 'abcdef0', 'passed', '2026-10-22', NONE)],
    ['date', row('Linux', '24', 'observed', 'npm run gate', 'v24.21.0', 'abcdef0', 'exit 0', 'October', NONE)]
  ])('reports an observed cell with no valid %s', (what, line) => {
    const problems = found(line);
    expect(problems).toHaveLength(1);
    expect(problems.at(0)).toContain(what);
  });

  it('reports an unobserved cell with no prerequisite, and one that carries an observation', () => {
    expect(found(row('Windows', '22', 'unobserved', NONE, NONE, NONE, NONE, NONE, NONE))).toEqual([
      'Windows / Node 22: unobserved with no prerequisite'
    ]);
    expect(found(row('Windows', '24', 'unobserved', 'npm run gate', NONE, NONE, NONE, NONE, 'a Windows host'))).toEqual([
      'Windows / Node 24: unobserved but carries a command'
    ]);
  });

  it('accepts both valid shapes', () => {
    expect(
      found(
        row('macOS', '24', 'observed', 'npm run gate', 'v24.21.0', '97083a1b', 'exit 0', '2026-10-22', NONE),
        row('Linux', '22', 'unobserved', NONE, NONE, NONE, NONE, NONE, 'a Linux host with Node 22')
      )
    ).toEqual([]);
  });
});
