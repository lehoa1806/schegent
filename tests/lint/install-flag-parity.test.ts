// FR-R3-090 (SUP-01) — the local install and the CI install are one policy, so
// they check against each other rather than drifting.
//
// THE GAP THIS CLOSES. Every job in `full-gate.yml`, `ci.yml` and `pr.yml`
// installs with `npm ci --ignore-scripts`. There was no `.npmrc` in either tree,
// so a contributor's plain `npm ci` ran third-party lifecycle scripts. The
// hardened posture was a property of the WORKFLOW FILES, not of the repository —
// which means the tree CI scanned was installed differently from the tree a
// contributor ran, and the contributor's was the less hardened of the two. It is
// also the one that runs an uncontained agent CLI.
//
// TWO AUTHORITIES ON ONE POLICY is the recurring defect FR-R3-066 exists to
// remove. The `.npmrc` files and the workflow flags are both real and neither
// can be derived from the other — npm reads one, Actions reads the other — so
// the remedy available here is the second-best one: make them CHECK against each
// other, in both directions.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const NPMRC_FILES = ['.npmrc', 'webview-ui/.npmrc'] as const;
const SELFTEST = 'scripts/clean-install-selftest.sh';

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** Every `npm ci` / `npm install` command a workflow executes. */
function installCommands(source: string): readonly string[] {
  const found: string[] = [];
  for (const rawLine of source.split('\n')) {
    const match = /^\s*(?:-\s+)?run:\s*(\S.*)$/.exec(rawLine);
    if (match === null) continue;
    for (const command of (match[1] as string).split('&&')) {
      const trimmed = command.trim();
      if (/^npm\s+(?:--prefix\s+\S+\s+)?(?:ci|install)\b/.test(trimmed)) found.push(trimmed);
    }
  }
  return found;
}

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => [file, readFileSync(resolve(WORKFLOW_DIR, file), 'utf8')] as const);

describe('FR-R3-090 — the local install matches the hardened CI install', () => {
  it('scanned a non-empty set of workflows that actually install', () => {
    // Without this floor, a rename of the workflow directory would empty the
    // scan and make every assertion below pass over nothing.
    expect(workflows.length).toBeGreaterThanOrEqual(5);
    const total = workflows.reduce((sum, [, source]) => sum + installCommands(source).length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('both trees configure ignore-scripts=true', () => {
    for (const file of NPMRC_FILES) {
      expect(existsSync(resolve(REPO_ROOT, file)), `${file} must exist`).toBe(true);
      const body = read(file)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(body, `${file} must set ignore-scripts=true`).toMatch(/^\s*ignore-scripts\s*=\s*true\s*$/m);
    }
  });

  it('every workflow install command carries --ignore-scripts', () => {
    const offenders: string[] = [];
    for (const [file, source] of workflows) {
      for (const command of installCommands(source)) {
        if (!command.includes('--ignore-scripts')) offenders.push(`${file}: ${command}`);
      }
    }
    expect(
      offenders,
      'A workflow that installs without --ignore-scripts is installing differently from every ' +
        'local checkout, which is the drift .npmrc was added to end.'
    ).toEqual([]);
  });

  it('the declared webview install step is documented, since .npmrc disables the postinstall that did it', () => {
    // The substance of FR-R3-090: `.npmrc` is one line, and the enumeration is
    // the work. The root postinstall populated `webview-ui/node_modules`; with
    // scripts off it does not run, so the replacement must be a DECLARED step
    // rather than a surprise.
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

  it('the clean-install self-test exists and CONTRIBUTING points at the policy it proves', () => {
    // The self-test runs a real install into a temporary clone. It is
    // deliberately NOT spawned from here: that would put a network `npm ci`
    // inside `test:host`, the suite vitest.config.ts documents as hermetic under
    // FR-R3-033. It runs as its own full-gate.yml job, where a slow network
    // install belongs, beside perf, integration and evidence-soak.
    expect(existsSync(resolve(REPO_ROOT, SELFTEST)), `${SELFTEST} must exist`).toBe(true);
    const fullGate = readFileSync(resolve(WORKFLOW_DIR, 'full-gate.yml'), 'utf8');
    expect(fullGate, 'the self-test must run somewhere, or it is a script nobody runs').toContain(
      'clean-install-selftest.sh'
    );
  });

  it('NON-VACUITY: a workflow install without --ignore-scripts is detected', () => {
    // Derived from a real workflow's real text, not a hand-written stub: the
    // flag is stripped from the file the gate actually reads.
    const [, realSource] = workflows.find(([file]) => file === 'full-gate.yml') as readonly [
      string,
      string
    ];
    const mutated = realSource.replace(/npm ci --ignore-scripts/, 'npm ci');
    expect(mutated).not.toBe(realSource);
    const offenders = installCommands(mutated).filter(
      (command) => !command.includes('--ignore-scripts')
    );
    expect(offenders.length).toBeGreaterThan(0);
    // ...and the unmutated file is clean, so the detector is not matching everything
    expect(
      installCommands(realSource).filter((command) => !command.includes('--ignore-scripts'))
    ).toEqual([]);
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
