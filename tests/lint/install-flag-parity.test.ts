// FR-R3-090 (SUP-01), amended by FR-R3-099 and FR-R3-101 — the install hardening,
// and the documents that teach it, check against each other.
//
// WHAT THIS GATE WAS. FR-R3-090 found the hardened install posture living in the
// workflow files rather than in the repository: every CI job ran `npm ci
// --ignore-scripts` while a contributor's plain `npm ci` ran third-party lifecycle
// scripts, so the tree CI scanned was installed differently from the tree a
// contributor ran — and the contributor's was the less hardened of the two, on the
// machine that runs an uncontained agent CLI. The fix was an `.npmrc` in both trees,
// and this gate existed because there were then TWO authorities on one policy (npm
// reads `.npmrc`, Actions read the flags) which could only be made to check each
// other, not derived from one another.
//
// WHAT CHANGED. FR-R3-099 retired GitHub Actions by operator decision and deleted
// all eight workflow files. The dual authority is therefore **structurally gone**:
// `.npmrc` is the only authority on how this repository installs, which is the
// outcome FR-R3-066 would have preferred all along. The workflow-flag half of this
// gate has no subject any more and is withdrawn; `docs/release/
// withdrawn-ci-controls.md` records that.
//
// WHAT REPLACES IT. The remaining drift risk moved: it is no longer local-versus-CI
// but hardening-versus-DOCUMENTATION. `.npmrc` disables the postinstall that used to
// install `webview-ui`, so every setup surface that still teaches a bare `npm
// install` hands a new contributor a checkout whose first build fails. FR-R3-101
// found four such surfaces. So this gate now checks the hardening against the
// documents that teach it, and `tests/lint/setup-surface-parity.test.ts` covers the
// full registered set.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const NPMRC_FILES = ['.npmrc', 'webview-ui/.npmrc'] as const;
const SELFTEST = 'scripts/clean-install-selftest.sh';

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** `.npmrc` with comments stripped, so a commented-out setting reads as absent. */
const settings = (relPath: string): string =>
  read(relPath)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('FR-R3-090 — the install hardening, and the documents that teach it', () => {
  it('both trees configure ignore-scripts=true', () => {
    for (const file of NPMRC_FILES) {
      expect(existsSync(resolve(REPO_ROOT, file)), `${file} must exist`).toBe(true);
      expect(settings(file), `${file} must set ignore-scripts=true`).toMatch(
        /^\s*ignore-scripts\s*=\s*true\s*$/m
      );
    }
  });

  it('no workflow reintroduces a second authority on the install policy', () => {
    // Actions are retired by decision, not by impossibility. If a workflow file
    // reappears, the dual authority reappears with it — and the last time that
    // happened the repository was the less hardened of the two. This is the one
    // workflow-shaped assertion worth keeping: it guards the ABSENCE.
    expect(
      existsSync(resolve(REPO_ROOT, '.github/workflows')),
      'A workflow directory reappeared. Either delete it, or restore the flag-parity ' +
        'assertions this gate withdrew — an installing workflow is a second authority ' +
        'on how this repository installs, and .npmrc cannot constrain it.'
    ).toBe(false);
  });

  it('the declared webview install step is documented, since .npmrc disables the postinstall that did it', () => {
    // The substance of FR-R3-090: `.npmrc` is one line, and the enumeration is the
    // work. The root postinstall populated `webview-ui/node_modules`; with scripts
    // off it does not run, so the replacement must be a DECLARED step rather than a
    // surprise.
    const manifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(
      manifest.scripts?.postinstall,
      'the postinstall this documents must still exist — if it is removed, remove its ' +
        'explanation too rather than leaving a document describing a script that is gone'
    ).toContain('--prefix webview-ui');

    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('npm --prefix webview-ui ci');
    expect(contributing).toContain('postinstall');
    expect(contributing).toContain('ignore-scripts=true');
  });

  it('the clean-install self-test exists, is invocable by name, and CONTRIBUTING says when to run it', () => {
    // FR-R3-099 left this script with NO caller: its only runner was a
    // `full-gate.yml` job, chosen because a slow network install belongs beside perf
    // and integration rather than inside the hermetic unit tier. Deleting the
    // workflow made it a script nobody runs — the exact shape FR-R3-109 objects to
    // in the unwired scanner.
    //
    // It is still not spawned from here, for the original reason: that would put a
    // network `npm ci` inside `test:host`, which vitest.config.ts documents as
    // hermetic under FR-R3-033. What it gains instead is a name and a stated
    // occasion, which is the most an offline gate can honestly give it.
    expect(existsSync(resolve(REPO_ROOT, SELFTEST)), `${SELFTEST} must exist`).toBe(true);
    const manifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(
      manifest.scripts?.['selftest:install'],
      'the clean-install self-test must be invocable by name, or it is a script nobody runs'
    ).toContain('clean-install-selftest.sh');
    expect(
      read('CONTRIBUTING.md'),
      'CONTRIBUTING must say when to run it, since no schedule does any more'
    ).toContain('selftest:install');
  });

  it('NON-VACUITY: an .npmrc without the setting is detected', () => {
    const real = read('.npmrc');
    const mutated = real.replace(/^\s*ignore-scripts\s*=\s*true\s*$/m, '# ignore-scripts=true');
    expect(mutated).not.toBe(real);
    const body = mutated
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(/^\s*ignore-scripts\s*=\s*true\s*$/m.test(body)).toBe(false);
  });
});
