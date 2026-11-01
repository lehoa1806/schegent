// FR-R4-F10 (contract L2, DOC1 to DOC6; FR-017, FR-031, FR-032; SC-007; tasks TA8, AN3) -- the documents
// say what the controls do, and what they do not.
//
// The gap this closes is wording, not code. Two controls are called by names that promise more than they
// deliver: the runtime redactor is described as "sanitized" in places that make it sound complete (it is
// best-effort secret-pattern redaction, and ordinary content, paths and unknown formats stay), and the
// secret scan's section said an AWS key was undetectable (a claim measured wrong) and named no limit of the
// staged mode or the hook. A claim in prose is not checked by anything, so this gate holds the words to the
// code. For the four documents that carry the "sanitized" wording, no line may use the word unless the
// same line says `secret-pattern`, and each replacement phrase must be present. For `SECURITY.md`, the
// scanner's section must name every family the matrix plants and every shape it records as unsupported
// (read from the matrix, so a new family cannot ship undocumented), the activation command, the bypass,
// the limits of the hook, and the one sentence that says an exported process definition is not redacted.
//
// Non-vacuity: the line check is run over an in-memory copy with a planted `Sanitized records` line, and
// must flag it; and it reports how many lines it read, so a path that stopped resolving cannot pass quietly.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLANTED, UNSUPPORTED } from '../fixtures/secret-scan-corpus';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The documents DOC3 names, each with the phrase its sites now carry and how many sites it has. */
const DOC3_FILES: ReadonlyArray<{ readonly file: string; readonly phrase: string; readonly minimumSites: number }> = [
  { file: 'docs/reference/file-layout.md', phrase: 'best-effort secret-pattern redacted', minimumSites: 3 },
  { file: 'docs/concepts/sessions-and-logs.md', phrase: 'best-effort secret-pattern redacted', minimumSites: 4 },
  { file: 'docs/reference/glossary.md', phrase: 'best-effort secret-pattern redacted', minimumSites: 1 },
  { file: 'docs/operations/runtime-log.md', phrase: 'best-effort secret-pattern redacted', minimumSites: 1 }
];

const SECURITY_FILE = 'SECURITY.md';
const SCAN_HEADING = '### The secret scan: what it is, and what it is not';
const NEXT_HEADING = '### What no longer runs, and what it cost';
const REDACTION_HEADING = '### Runtime redaction: what it is, and what it is not';

function read(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** The 1-based numbers of lines that use `sanitized` or `sanitised` without saying `secret-pattern`. */
function unqualifiedLines(text: string): number[] {
  const found: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (/saniti[sz]ed/i.test(line) && !line.includes('secret-pattern')) found.push(index + 1);
  });
  return found;
}

/** From the secret-scan heading to the next section: the scan's section and the runtime subsection after it. */
function scannerSections(text: string): string {
  const start = text.indexOf(SCAN_HEADING);
  const end = text.indexOf(NEXT_HEADING);
  expect(start, `${SECURITY_FILE} has no "${SCAN_HEADING}" heading`).toBeGreaterThanOrEqual(0);
  expect(end, `${SECURITY_FILE} has no "${NEXT_HEADING}" heading`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('credential-wording: the four documents that say "sanitized" (DOC3, DOC6)', () => {
  it.each(DOC3_FILES.map((entry) => [entry.file, entry] as const))(
    '%s: no line says sanitized without saying secret-pattern',
    (_file, entry) => {
      const text = read(entry.file);
      expect(text.split('\n').length, `${entry.file} was read as empty`).toBeGreaterThan(40);
      expect(unqualifiedLines(text), `${entry.file}: lines that say sanitized or sanitised unqualified`).toEqual([]);
    }
  );

  it.each(DOC3_FILES.map((entry) => [entry.file, entry] as const))(
    '%s: carries the replacement phrase at each site',
    (_file, entry) => {
      const sites = read(entry.file).split(entry.phrase).length - 1;
      expect(sites, `${entry.file}: "${entry.phrase}" appears ${sites} time(s)`).toBeGreaterThanOrEqual(entry.minimumSites);
    }
  );

  it('NON-VACUITY: a planted Sanitized records line fails the line check', () => {
    const real = read('docs/reference/file-layout.md');
    expect(unqualifiedLines(real)).toEqual([]);
    const planted = `${real}\n| \`x.log\` | Sanitized records, one per line |\n`;
    expect(unqualifiedLines(planted).length).toBe(1);
    expect(unqualifiedLines('Sanitized records, best-effort secret-pattern redacted\n')).toEqual([]);
  });
});

describe('credential-wording: SECURITY.md names the scanner families, the limits and the hook (DOC1, DOC2)', () => {
  const security = read(SECURITY_FILE);
  const section = scannerSections(security);

  it('names every planted family in backticks, from the matrix', () => {
    expect(PLANTED.length).toBeGreaterThanOrEqual(22);
    const missing = PLANTED.map((planted) => planted.family).filter((family) => !section.includes(`\`${family}\``));
    expect(missing, 'families the matrix plants that the scanner section does not name').toEqual([]);
  });

  it('names every unsupported shape, from the matrix', () => {
    expect(UNSUPPORTED.length).toBeGreaterThanOrEqual(5);
    const missing = UNSUPPORTED.map((shape) => shape.name).filter((name) => !section.includes(name));
    expect(missing, 'unsupported shapes the scanner section does not name').toEqual([]);
  });

  it.each([
    'git config core.hooksPath scripts/hooks',
    '--no-verify',
    'conflict-free merge',
    'history',
    'best-effort secret-pattern redaction'
  ])('says %s', (phrase) => {
    expect(section, `the scanner section and the runtime subsection do not say "${phrase}"`).toContain(phrase);
  });

  it('says in one line that the process-definition export is written without redaction', () => {
    const lines = section.split('\n').filter((line) => line.includes('process-definition export') && line.includes('without redaction'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('has the runtime-redaction subsection after the scan section, and no stale AWS claim', () => {
    expect(security.indexOf(REDACTION_HEADING), `${SECURITY_FILE} has no "${REDACTION_HEADING}" subsection`).toBeGreaterThan(
      security.indexOf(SCAN_HEADING)
    );
    expect(section).not.toContain('wants a pair');
  });
});
