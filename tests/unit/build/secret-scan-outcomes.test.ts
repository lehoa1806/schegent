import { afterEach, describe, expect, it } from 'vitest';
import { removeSandboxes, sandbox, scan } from './secret-scan-harness';

/**
 * The secret scan reads every file it is given, prints no value it finds, and refuses a run
 * that has nothing to read.
 *
 * Three findings of the feature-229 security review (S4, S5 and R3-02; the envelope's
 * `docs/features/round_3/INDEX.md` section 24 records where each went), each a way
 * `scripts/scan-secrets.mjs` reported less than it was given:
 *
 * - S4. `git ls-files` without `-z` quotes a name that holds a byte outside printable ASCII, a
 *   double quote or a backslash. The quoted form names no file on disk, so the scan counted the
 *   file absent, never read it, and passed.
 * - S5. secretlint's type declarations say masking is the default, and its core reads
 *   `maskSecrets ?? false`, so a report line carried the matched value to the terminal and to
 *   any log that keeps it.
 * - R3-02. With no file to scan it printed `secretlint over 0 tracked file(s)` and exited 0.
 *   Outside a repository of its own, such as an archive unpacked inside a repository that does
 *   not track it, `git ls-files` exits 0 and prints nothing.
 *
 * The scan finds its root from its own location, so each case copies it, the module it imports
 * and this repository's configuration into a fresh repository, and links this tree's
 * `node_modules` for the engine. Every file is written under the run's temp root. The planted
 * token is assembled at run time, so this file holds no value for the repository's own scan to
 * report.
 */
// The part of the token a partial mask would still show.
const TOKEN_TAIL = 'Zq3K8vR2mN7pL4wT9yB6cD1f';
const PLANTED_TOKEN = ['xo', 'xb-', '1234567890-', '1234567890-', TOKEN_TAIL].join('');
// Outside printable ASCII, so `git ls-files` quotes it when `core.quotePath` is on, its default.
const QUOTED_NAME = 'café-notes.txt';

afterEach(removeSandboxes);

describe('the secret scan reports what it was given', () => {
  it('passes a clean tree and prints the scope it read', () => {
    // The control: the copied scan runs, and a pass names its file count.
    const { status, out } = scan(sandbox({ 'clean.txt': 'nothing to see\n' }));
    expect(status, out).toBe(0);
    expect(out).toContain('Secret scan: secretlint over 1 tracked file(s)');
  });

  it('reads a file whose name git quotes (S4)', () => {
    const root = sandbox({
      'clean.txt': 'nothing to see\n',
      [QUOTED_NAME]: `token = "${PLANTED_TOKEN}"\n`
    });
    const { status, out } = scan(root);
    expect(status, `a token in ${QUOTED_NAME} must fail the scan. Got: ${out}`).toBe(1);
    expect(out).toContain(QUOTED_NAME);
    expect(out).toContain('secretlint over 2 tracked file(s)');
    expect(out).not.toContain('absent from disk');
  });

  it('names the rule and the place of a finding, never its value (S5)', () => {
    const { status, out } = scan(sandbox({ 'leak.txt': `token = "${PLANTED_TOKEN}"\n` }));
    expect(status, out).toBe(1);
    expect(out).toContain('leak.txt');
    expect(out).toContain('SLACK_TOKEN');
    expect(out).not.toContain(TOKEN_TAIL);
  });

  it('refuses a tree with no tracked file instead of passing over nothing (R3-02)', () => {
    const { status, out } = scan(sandbox({}));
    expect(status, out).toBe(1);
    expect(out).toContain('Secret scan cannot run: no tracked file to scan');
    expect(out).not.toContain('secretlint over 0 tracked file(s)');
  });
});
