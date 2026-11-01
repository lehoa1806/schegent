import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-038, SC-012; research R25; contract L8) -- no live document says `license:check`
 * validates dependency licenses.
 *
 * WHAT THE CHECK DOES. `scripts/check-licenses.mjs` establishes three structural facts: `LICENSE.md`
 * exists, the license operations record exists, and the manifest's `license` field is set. It reads
 * no dependency and no lockfile. A page that says it validates "production dependency licenses", or
 * that a gate covers a "production-license policy", describes a control that does not exist, and a
 * reader who trusts it ships believing a license review happened. Two pages said so on the day this
 * gate was written: `docs/how-to/developer-workflows.md` (the sentence wraps across two lines) and
 * `CONTRIBUTING.md`. They are its probes: the patterns below catch them, and the gate is green once
 * they are corrected.
 *
 * HOW IT READS. Each live Markdown page under `repo/` has its whitespace normalized first, because a
 * sentence wraps; it is then split into sentences, and a sentence that carries a negation ("it does
 * not inspect dependency licenses") is skipped, because the corrected pages say exactly that. A page
 * marked as a record is skipped as every claim gate here skips one. The patterns are assertion-shaped
 * and checked against planted sentences, so a pattern that decays into matching nothing fails here
 * instead of going quiet over the tree.
 *
 * Hermetic: `readFileSync` over the working tree, no network and no spawn.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD_MARKER = '<!-- doc-class: record -->';
const MARKER_WINDOW = 10;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.tmp', 'out', '.git', '.release']);

/** Ways a page says a license control covers dependencies. Each is a claim, not a subject. */
const CLAIMS: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp }> = [
  {
    id: 'validates-dependency-licenses',
    pattern: /\bvalidat(?:e|es|ed|ing|ion)\b[^.|]{0,40}\b(?:production|dependency|dependencies)\b[^.|]{0,20}\blicen[sc]es?\b/i
  },
  { id: 'production-license-policy', pattern: /\bproduction[- ]licen[sc]e\b/i },
  {
    id: 'license-check-covers-dependencies',
    pattern: /\blicen[sc]e:check\b[^.|]{0,100}\b(?:production|dependency|dependencies)\b[^.|]{0,20}\blicen[sc]es?\b/i
  },
  {
    id: 'checks-dependency-licenses',
    pattern: /\b(?:checks?|verif(?:y|ies)|audits?|enforces?)\b[^.|]{0,40}\b(?:production|dependency|dependencies)\b[^.|]{0,15}\blicen[sc]es?\b/i
  }
];

/** A sentence that denies the claim is the corrected wording, not an offender. */
const NEGATION = /\b(?:not|never|no|neither|nor|without|cannot|does not|do not)\b/i;

/** Markdown pages under `root`, repository-relative, minus build output and dependency trees. */
function livePages(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(relative(root, join(directory, entry.name)));
      }
    }
  };
  walk(root);
  return found.sort();
}

const isRecordPage = (body: string): boolean =>
  body.split('\n', MARKER_WINDOW).some((line) => line.trim() === RECORD_MARKER);

/** The claims a body makes, as `id: sentence`. Whitespace is normalized so a wrapped sentence is read whole. */
function offendingSentences(body: string): string[] {
  const flat = body.replace(/\s+/g, ' ');
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z`*([])/);
  return sentences.flatMap((sentence) => {
    if (NEGATION.test(sentence)) return [];
    return CLAIMS.filter(({ pattern }) => pattern.test(sentence)).map(({ id }) => `${id}: ${sentence.slice(0, 120)}`);
  });
}

describe('FR-R4-F09 — no live page describes license:check as validating dependency licenses', () => {
  const pages = livePages(REPO_ROOT);

  it('reads a real set of pages, so a clean result is not an empty scan', () => {
    expect(pages.length).toBeGreaterThan(60);
    expect(pages).toContain('CONTRIBUTING.md');
    expect(pages).toContain('docs/how-to/developer-workflows.md');
  });

  it('finds no offending sentence in any live page', () => {
    const offenders = pages.flatMap((page) => {
      const body = readFileSync(resolve(REPO_ROOT, page), 'utf8');
      return isRecordPage(body) ? [] : offendingSentences(body).map((sentence) => `${page} -> ${sentence}`);
    });
    expect(
      offenders,
      '`license:check` verifies three structural facts (LICENSE.md, the license record, the manifest ' +
        'license field) and reads no dependency. Say that.'
    ).toEqual([]);
  });
});

describe('NON-VACUITY: the patterns catch the two probes and the wording around them', () => {
  const found = (text: string): string[] => offendingSentences(text).map((entry) => entry.split(':')[0] ?? '');

  it('catches the how-to sentence as it stood, across its line break', () => {
    const wrapped =
      'Run `npm run license:check` to validate production\ndependency licenses. Since the workflows were retired the pin check has a third purpose.';
    expect(found(wrapped)).toContain('validates-dependency-licenses');
  });

  it('catches the contributor guide sentence as it stood', () => {
    const guide =
      '`verify:all` covers contract freshness, documentation, secret scanning, pinned actions, production-license policy, all type checks, both lint passes, host tests, and covered webview tests.';
    expect(found(guide)).toContain('production-license-policy');
  });

  it('catches the same claim made about the gate, and about the script by name', () => {
    expect(found('The gate validates dependency licenses before a release.')).toContain('validates-dependency-licenses');
    expect(found('`license:check` checks the production dependency licenses of the tree.').length).toBeGreaterThan(0);
  });

  it('does not report the corrected wording, which denies the claim', () => {
    expect(
      found('`scripts/check-licenses.mjs` checks that `LICENSE.md` exists; it does not inspect dependency licenses.')
    ).toEqual([]);
    expect(found('There is no production-license policy check in this repository.')).toEqual([]);
  });

  it('does not report a sentence that merely mentions licenses', () => {
    expect(found('Every dependency ships under its own license, listed in the SBOM.')).toEqual([]);
    expect(found('The structural license check covers `LICENSE.md`, the license record and the manifest field.')).toEqual([]);
  });

  it('skips a page marked as a record', () => {
    const record = `# History\n\n${RECORD_MARKER}\n\nThe gate validated production dependency licenses.`;
    expect(isRecordPage(record)).toBe(true);
    expect(isRecordPage('# Page\n\nThe gate validates production dependency licenses.')).toBe(false);
  });
});
