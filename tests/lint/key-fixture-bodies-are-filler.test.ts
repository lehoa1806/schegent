import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-109 — the compensating control for the four private-key fixtures that
 * `.secretlintignore` exempts.
 *
 * WHY THIS EXISTS. Wiring secretlint found 21 private-key findings, all of them in four
 * files whose purpose is to contain key headers so the redaction path can be tested.
 * They had to be exempted at **file** scope, because `secretlint-rule-privatekey`
 * matches the header and a real key's header is byte-identical to a fixture's — there is
 * no value to allow that would not also allow every real key everywhere.
 *
 * File scope is how the OLD defect worked: the previous scan skipped `tests/**`
 * wholesale, so a real credential pasted into a test file was invisible by construction.
 * Four files is a much smaller hole than one directory, but it is the same shape. So the
 * hole is covered from the other side: secretlint no longer looks at these files, and
 * this gate asserts that what is in them cannot be a real key.
 *
 * WHAT "CANNOT BE A REAL KEY" MEANS HERE. A PEM body is long base64. These fixtures
 * carry sentinels (`BODY_SENTINEL`), the literal word `Filler`, an ellipsis standing in
 * for elided bytes, or nothing at all between header and footer. The check is therefore:
 * no run of base64-shaped characters long enough to be key material. It is a heuristic,
 * and it is a heuristic pointed at a small, named, hand-written set — not at the tree.
 */
const ROOT = resolve(__dirname, '..', '..');

/**
 * The files `.secretlintignore` exempts for private keys. Kept here as a literal so the
 * two lists can be compared, which the last test does — an exemption this gate does not
 * know about would be uncovered.
 */
const EXEMPTED = [
  'tests/fixtures/key-block-corpus.ts',
  'tests/unit/lib/key-block-redaction.test.ts',
  'tests/unit/lib/logger.test.ts',
  'tests/unit/monitor/cli-transport-sink.test.ts'
] as const;

/**
 * Long enough to be key material. The shortest real PEM body (a 256-bit EC key) is
 * comfortably over 100 base64 characters; fixture fillers here are under 40.
 */
const KEY_MATERIAL_MIN = 100;
const BASE64_RUN = /[A-Za-z0-9+/=]{100,}/g;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

describe('FR-R3-109 — the exempted key fixtures carry filler, not key material', () => {
  it('every exempted file exists and does contain key headers, or the exemption is stale', () => {
    for (const file of EXEMPTED) {
      const body = read(file);
      expect(
        body,
        `${file} is exempted from the secret scan but contains no key header. Remove the ` +
          'exemption rather than leaving a hole nothing needs.'
      ).toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });

  it('no exempted file carries a base64 run long enough to be real key material', () => {
    const offenders: string[] = [];
    for (const file of EXEMPTED) {
      for (const match of read(file).matchAll(BASE64_RUN)) {
        offenders.push(`${file}: ${match[0].slice(0, 24)}… (${match[0].length} chars)`);
      }
    }
    expect(
      offenders,
      'A file exempted from the secret scan now carries something long enough to be a real ' +
        'private key. secretlint does not look at these files, so this gate is the only ' +
        'thing standing between a pasted credential and a green scan. If the content is a ' +
        'legitimate long fixture, shorten it or elide the middle — do not widen this bound.'
    ).toEqual([]);
  });

  it('the exemption list here matches the one in .secretlintignore', () => {
    // Two lists that must agree: an entry in .secretlintignore that this gate does not
    // know about is an uncovered hole, and an entry here that is no longer exempted is a
    // gate guarding nothing.
    const ignore = read('.secretlintignore');
    const declared = ignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('tests/') && line.endsWith('.ts'));
    expect([...declared].sort()).toEqual([...EXEMPTED].sort());
  });

  it('NON-VACUITY: a plausible key body in an exempted file is detected', () => {
    // Derived from the real bound, not a hand-picked string: a base64 run one character
    // past the threshold must match, and one character short must not.
    const justLong = 'A'.repeat(KEY_MATERIAL_MIN);
    const justShort = 'A'.repeat(KEY_MATERIAL_MIN - 1);
    expect(new RegExp(BASE64_RUN.source).test(justLong)).toBe(true);
    expect(new RegExp(BASE64_RUN.source).test(justShort)).toBe(false);
  });
});
