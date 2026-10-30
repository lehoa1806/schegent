import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-024, SC-005, R4, R17) — the advisory comparison is report-only, and
 * stays outside every chain that gives a verdict.
 *
 * `npm run security:advisory-diff` tells an operator whether a candidate introduced or worsened an
 * advisory. If a gate, a verify tier, the release or a Phase ever ran it, its exit code would
 * become a verdict, and a comparison that is deliberately never a waiver would become one by
 * accident. This gate keeps four things true:
 *
 *   1. `security:audit`, the absolute audit, still has the body it had before the command existed.
 *   2. No chain reaches the command: the closure of each script that gives a verdict names neither
 *      `security:advisory-diff` nor `advisory-diff.mjs`.
 *   3. No file under `examples/` names it, so no Phase or pipeline runs it.
 *   4. The derived release-control facts are unchanged: still no audit in the gate closure, and no
 *      producer of checksums or of independently verifiable provenance. A lockfile digest computed
 *      with the hashing call the checksum detector looks for would flip the generated release page
 *      to say checksums exist.
 *
 * It searches by script name and by file name, never by a body's value (hard rule 67), and it is
 * hermetic: nothing is spawned. Each assertion is a pure function, and a planted tree built under
 * `mkdtemp` proves the matching assertion can go red, as `current-control-claims.test.ts` does for
 * its own facts.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

const COMMAND = 'security:advisory-diff';
const ENTRY_FILE = 'advisory-diff.mjs';

/** `security:audit` as it was when the command was added: the absolute audit, unchanged. */
const ABSOLUTE_AUDIT = 'npm audit --audit-level=low && npm --prefix webview-ui audit --audit-level=low';

/** The scripts that give a verdict, a release or a package. None may reach the command. */
const CHAINS = [
  'gate',
  'ci',
  'ci:fast',
  'verify:all',
  'verify:edit',
  'verify:push',
  'verify:release',
  'release',
  'package'
] as const;

type Scripts = Readonly<Record<string, string>>;

interface Facts {
  readonly auditInGateClosure: boolean;
  readonly emitsChecksums: boolean;
  readonly emitsIndependentProvenance: boolean;
}

let reachableScripts: (all: Scripts, entry: string) => readonly string[];
let controlFacts: (root?: string) => Facts;

beforeAll(async () => {
  // Computed specifiers: both modules are `.mjs`, and a literal specifier from this CommonJS test
  // file is TS1479. The facts module has no declaration file at all.
  const load = async (name: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(resolve(REPO_ROOT, 'scripts', name)).href)) as Record<string, unknown>;
  const parity = await load('check-gate-coverage-parity.mjs');
  reachableScripts = parity['reachableScripts'] as typeof reachableScripts;
  const facts = await load('current-control-facts.mjs');
  controlFacts = facts['controlFacts'] as typeof controlFacts;
});

function scriptsOf(root: string): Scripts {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Scripts };
  return manifest.scripts ?? {};
}

/** Every chain whose closure names the command, by script name or by the file it runs. */
function chainViolations(scripts: Scripts): string[] {
  const found: string[] = [];
  for (const chain of CHAINS) {
    for (const name of reachableScripts(scripts, chain)) {
      const body = scripts[name] ?? '';
      if (name === COMMAND) found.push(`${chain} reaches the script ${COMMAND}`);
      else if (body.includes(ENTRY_FILE)) found.push(`${chain} reaches ${name}, whose body runs ${ENTRY_FILE}`);
    }
  }
  return found;
}

/** Every file under `dir` that names the command or its file, none followed through a link. */
function filesNaming(dir: string): { readonly scanned: number; readonly hits: string[] } {
  let scanned = 0;
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        scanned += 1;
        const text = readFileSync(path, 'utf8');
        if (text.includes(COMMAND) || text.includes(ENTRY_FILE)) hits.push(path);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { scanned, hits };
}

/** The derived facts that would change if the command acted as a control, as a list of what moved. */
function factViolations(facts: Facts): string[] {
  const moved: string[] = [];
  if (facts.auditInGateClosure) moved.push('the audit is reached by the gate');
  if (facts.emitsChecksums) moved.push('a producer of release checksums appeared');
  if (facts.emitsIndependentProvenance) moved.push('a producer of verifiable provenance appeared');
  return moved;
}

const real = (): Scripts => scriptsOf(REPO_ROOT);

describe('1. security:audit is the absolute audit, untouched', () => {
  it('has the body it had before the advisory comparison existed', () => {
    expect(real()['security:audit']).toBe(ABSOLUTE_AUDIT);
  });

  it('is a different script from the comparison', () => {
    expect(real()[COMMAND]).toBeDefined();
    expect(real()[COMMAND]).not.toBe(real()['security:audit']);
  });
});

describe('2. no chain that gives a verdict reaches the comparison', () => {
  it('reaches every chain, and each closure is a real walk rather than an empty one', () => {
    for (const chain of CHAINS) {
      expect(real()[chain], `${chain} must exist`).toBeDefined();
      expect(reachableScripts(real(), chain), chain).toContain(chain);
    }
    // The gate composes others; a walk that returned only the entry would pass this gate vacuously.
    expect(reachableScripts(real(), 'gate').length).toBeGreaterThan(5);
  });

  it('finds neither the script name nor its file in any closure', () => {
    expect(chainViolations(real())).toEqual([]);
  });

  it('NON-VACUITY: a manifest whose verify:all runs the command is reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'advisory-report-only-'));
    const scripts = { ...real(), 'verify:all': `${real()['verify:all'] ?? ''} && npm run ${COMMAND}` };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
    const violations = chainViolations(scriptsOf(root));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((line) => line.startsWith('verify:all '))).toBe(true);
  });

  it('NON-VACUITY: a script that runs the command file is reported through any chain that reaches it', () => {
    const scripts = { ...real(), 'planted:helper': `node scripts/${ENTRY_FILE}`, release: `${real()['release'] ?? ''} && npm run planted:helper` };
    expect(chainViolations(scripts).some((line) => line.includes('planted:helper'))).toBe(true);
  });
});

describe('3. no Phase or pipeline file names the comparison', () => {
  it('finds neither the script name nor its file under examples/', () => {
    const { scanned, hits } = filesNaming(resolve(REPO_ROOT, 'examples'));
    expect(scanned, 'examples/ must be scanned, or this assertion is vacuous').toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('NON-VACUITY: a planted example that names the command is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'advisory-report-only-'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'phase.md'), `Run npm run ${COMMAND} before finishing.\n`);
    expect(filesNaming(root).hits).toHaveLength(1);
  });
});

describe('4. the derived release-control facts are unchanged', () => {
  it('still reports no audit in the gate closure, no checksum producer and no verifiable provenance', () => {
    expect(factViolations(controlFacts(REPO_ROOT))).toEqual([]);
    const facts = controlFacts(REPO_ROOT);
    expect(facts.auditInGateClosure).toBe(false);
    expect(facts.emitsChecksums).toBe(false);
    expect(facts.emitsIndependentProvenance).toBe(false);
  });

  it('NON-VACUITY: a scripts/ file that hashes with the checksum detector\'s call is reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'advisory-report-only-'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { release: 'echo release' }, engines: { node: '^22 || ^24' } })
    );
    // Composed, not written out: the call is what `controlFacts` looks for in a scripts/ file.
    const call = ['create', 'Hash'].join('');
    writeFileSync(join(root, 'scripts', 'planted.mjs'), `const digest = ${call}('sha256');\n`);
    expect(factViolations(controlFacts(root))).toContain('a producer of release checksums appeared');
  });
});
