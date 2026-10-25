// FR-R3-203 — the stdout contract's strings get one home.
//
// The audit block's two markers and the termination token are printed by the
// prompt, found by the host's parsers, and read again by the activity feed's audit
// card. Each reader kept its own copy of the strings, and the copies drifted: the
// card looked for a close marker the host never prints, so every real block read
// as truncated and the badge could contradict the run's verdict. The strings and
// the token rule now live in one module, and this gate is what keeps a fourth
// reader from growing its own copy.
//
// The needles are matched on raw text, comments included, because the defect was
// a string, and a comment that spells the string is the first step of a copy.
// Prose says "the open marker", "the close marker" or "the token".
//
// NOT checked: tests, which build the host's block from the module's exports and
// legitimately name the strings to pin them; and whether the module's own values
// are right (`phase-output-contract.test.ts` pins them).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Named by path segments, never as a quoted path: during the red run the home
// may not exist yet, and `lint-anchor-grounding` reads quoted paths as claims.
const HOME = ['src', 'contracts', 'phase-output-contract.ts'].join('/');

// Built from segments so that no line of this file holds the spelling the
// activity feed used to look for: the acceptance search for it covers all of the
// repository, this file included.
const OLD_CLOSE_SPELLING = ['END', 'SCHEGENT', 'AUDIT', 'LOG'].join(' ');

const NEEDLES: readonly string[] = [
  '=== SCHEGENT AUDIT LOG ===',
  '=== END AUDIT LOG ===',
  OLD_CLOSE_SPELLING,
  'SCHEGENT_STATUS'
];

const SCAN_ROOTS = [
  { root: resolve(REPO_ROOT, 'src'), extensions: ['.ts'] },
  { root: resolve(REPO_ROOT, 'webview-ui', 'src'), extensions: ['.ts', '.svelte'] }
] as const;

const CONSUMERS: readonly string[] = [
  ['src', 'parser', 'audit-log-parser.ts'].join('/'),
  ['src', 'parser', 'stdout-parser.ts'].join('/'),
  ['src', 'runner', 'prompt-builder.ts'].join('/'),
  ['webview-ui', 'src', 'lib', 'activity-feed', 'detect-audit-footer.ts'].join('/')
];

function holdsNeedle(text: string): boolean {
  return NEEDLES.some((needle) => text.includes(needle));
}

interface ScannedFile {
  readonly rel: string;
  readonly text: string;
}

function scannedSources(): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const { root, extensions } of SCAN_ROOTS) {
    for (const file of filesUnder(root, { extensions })) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      // Tests build the host's block from the module's exports and pin its values.
      if (rel.includes('__tests__') || rel.includes('.test.')) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      out.push({ rel, text });
    }
  }
  return out;
}

describe('the phase output contract has one home', () => {
  it('G-1: no source outside the home holds a marker or the token', () => {
    const offenders = scannedSources()
      .filter(({ rel, text }) => rel !== HOME && holdsNeedle(text))
      .map(({ rel }) => rel)
      .sort();
    expect(
      offenders,
      `These files spell the audit block's markers or the termination token instead of ` +
        `taking them from ${HOME}, which exports AUDIT_LOG_OPEN_MARKER, ` +
        `AUDIT_LOG_CLOSE_MARKER, TERMINATION_TOKEN and containsTerminationToken. ` +
        `Import them; in prose, say "the open marker", "the close marker" or "the token".\n` +
        offenders.join('\n')
    ).toEqual([]);
  });

  // Vacuity control: the assertion above subtracts the home from a scan and
  // expects nothing left, which is exactly what a scan that found nothing
  // produces. So the scan must have reached the home and every reader.
  it('G-2: the scan reached the home and the four readers, and the home holds the strings', () => {
    const files = scannedSources();
    const scanned = files.map(({ rel }) => rel);
    expect(files.length, 'the scan roots yielded one file or none').toBeGreaterThan(1);
    expect(scanned, `${HOME} was not scanned: it moved, or the scan no longer reaches it`).toContain(
      HOME
    );
    for (const consumer of CONSUMERS) {
      expect(scanned, `${consumer} was not scanned`).toContain(consumer);
    }
    const home = files.find(({ rel }) => rel === HOME)?.text ?? '';
    expect(home).toContain('=== SCHEGENT AUDIT LOG ===');
    expect(home).toContain('=== END AUDIT LOG ===');
    expect(home).toContain('SCHEGENT_STATUS');
  });

  it('G-3: the matcher flags each needle in code and in a comment, and leaves prose alone', () => {
    // A second spelling of the set, not NEEDLES itself: a needle dropped from
    // NEEDLES must fail here, and a loop over NEEDLES cannot notice its own loss.
    const mustBeFlagged = [
      '=== SCHEGENT AUDIT LOG ===',
      '=== END AUDIT LOG ===',
      OLD_CLOSE_SPELLING,
      'SCHEGENT_STATUS'
    ];
    for (const needle of mustBeFlagged) {
      expect(holdsNeedle(`const spelled = '${needle}';`), `code line: ${needle}`).toBe(true);
      expect(holdsNeedle(`// the line reads ${needle}`), `comment: ${needle}`).toBe(true);
    }
    expect(holdsNeedle('// the SCHEGENT AUDIT LOG footer')).toBe(false);
    expect(holdsNeedle(`// the ${OLD_CLOSE_SPELLING} sentinel`)).toBe(true);
  });
});
