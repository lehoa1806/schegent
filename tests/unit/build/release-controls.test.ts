import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-004; research R1 and R9; contract test T14) -- the generated release-controls page
 * still tells the truth now that the release is a driver, and now that a digest producer exists.
 *
 * Two facts moved, and each could have gone wrong silently.
 *
 *  - `releaseReachesSbom`. The fact walks `npm run` references in `package.json`, and the release
 *    driver spawns `build` and `sbom` itself, so a driver the walk cannot see would flip the page
 *    to "Not produced". The driver exports the scripts it spawns, and the facts add their
 *    closures. The addition counts a child only when `package.json` has that script, because
 *    `reachableScripts` returns its entry whether or not it exists, and a closure that always
 *    held `sbom` would make the fact true of any repository.
 *  - `emitsChecksums`. The detector finds any file under `scripts/` that hashes with the call it
 *    looks for. Exactly one file may, `release-digest.mjs`, and a second one anywhere is reported
 *    by name, which is what keeps the page's "produced by" row naming one reviewed file.
 *
 * Both are asserted against the real tree and against a copy of it with a producer planted.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SANCTIONED = 'scripts/release-digest.mjs';

interface Facts {
  readonly releaseReachesSbom: boolean;
  readonly emitsChecksums: boolean;
  readonly evidence: { readonly checksums: readonly string[] };
}
let controlFacts: (root?: string) => Facts;
let childScripts: readonly string[];

beforeAll(async () => {
  // Computed specifiers: both modules are `.mjs`, and a literal specifier from this CommonJS test
  // file is TS1479. The facts module has no declaration file at all.
  const load = async (name: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(resolve(REPO_ROOT, 'scripts', name)).href)) as Record<string, unknown>;
  controlFacts = (await load('current-control-facts.mjs'))['controlFacts'] as typeof controlFacts;
  childScripts = (await load('release-candidate.mjs'))['RELEASE_CHILD_SCRIPTS'] as readonly string[];
});

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A copy of the facts' inputs: `package.json` and the whole `scripts/` directory. */
function copyOfInputs(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-controls-'));
  roots.push(root);
  cpSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  return root;
}

/** A manifest and scripts tree with the given npm scripts and nothing else. */
function bareTree(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'release-controls-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

describe('the real tree', () => {
  it('reaches the SBOM through the scripts the release driver spawns', () => {
    expect(controlFacts(REPO_ROOT).releaseReachesSbom).toBe(true);
  });

  it('lists the build before the SBOM, because the SBOM reads the build\'s module graphs', () => {
    expect([...childScripts]).toEqual(['build', 'sbom']);
    expect(childScripts.indexOf('build')).toBeLessThan(childScripts.indexOf('sbom'));
  });

  it('names exactly one checksum producer, the release digest module', () => {
    const facts = controlFacts(REPO_ROOT);
    expect(facts.emitsChecksums).toBe(true);
    expect(facts.evidence.checksums).toEqual([SANCTIONED]);
  });
});

describe('a copy of the facts\' inputs', () => {
  it('CONTROL: the unmodified copy reports the same single producer as the tree', () => {
    expect(controlFacts(copyOfInputs()).evidence.checksums).toEqual([SANCTIONED]);
  });

  it('reports a second scripts/ file that hashes, by name', () => {
    const root = copyOfInputs();
    // Composed, not written out: the call is what `controlFacts` looks for in a scripts/ file.
    const call = ['create', 'Hash'].join('');
    writeFileSync(
      join(root, 'scripts', 'planted-second-producer.mjs'),
      `export const digest = ${call}('sha256');\n`
    );
    expect(controlFacts(root).evidence.checksums).toEqual([
      ['scripts', 'planted-second-producer.mjs'].join('/'),
      SANCTIONED
    ]);
  });

  it('would not call the copy clean if the sanctioned module were gone', () => {
    const root = copyOfInputs();
    rmSync(join(root, SANCTIONED));
    expect(controlFacts(root).emitsChecksums).toBe(false);
    expect(readFileSync(join(REPO_ROOT, SANCTIONED), 'utf8')).toContain('sha256');
  });
});

describe('the child scripts of the release driver', () => {
  it('count toward the release closure when package.json has them', () => {
    const root = bareTree({
      release: 'node scripts/prepare-release.mjs',
      build: 'echo build',
      sbom: 'echo sbom'
    });
    expect(controlFacts(root).releaseReachesSbom).toBe(true);
  });

  it('NON-VACUITY: do not count when package.json lacks the script, so the fact can be false', () => {
    const root = bareTree({ release: 'node scripts/prepare-release.mjs', build: 'echo build' });
    expect(controlFacts(root).releaseReachesSbom).toBe(false);
  });

  it('NON-VACUITY: a release that names sbom only in prose does not reach it', () => {
    const root = bareTree({ release: 'echo "the sbom is made elsewhere"' });
    expect(controlFacts(root).releaseReachesSbom).toBe(false);
  });
});
