// Feature 106 (T592c, FR-012, FR-021) — the packaging gates have no repair mode.
//
// Twenty-five pinned entries were replaced by two shape predicates and a
// correspondence, and the obvious next convenience is a `--update` flag that
// rewrites the allowlist from whatever the last build happened to emit. That flag
// would end the gate: a check whose expectation is regenerated from the subject it
// is checking cannot disagree with it. The pin went stale five times and every one
// of those was caught precisely because no tool could quiet it.
//
// The staleness refusal has the same property for the same reason (FR-021). A
// check that rebuilt the output it found stale would make the next run pass
// without anyone having decided the output should change.
//
// Two rules, scanned as text rather than inferred from behaviour, because the
// thing being forbidden is a code path that does not exist yet:
//
//   1. No update/write/fix flag, and no `process.argv` read beyond the script
//      name and the single positional VSIX path.
//   2. The two pure-policy scripts call no filesystem write API at all.
//      `package-vsix-smoke.mjs` is exempt from rule 2 and only from rule 2: it
//      legitimately creates and removes its own temporary directory.
//
// T592c originally recorded this as an observation — `rg` found only the
// positional `process.argv[2]` and no flags. An observation is a fact about the
// tree on the day it was taken; the batch's own discipline is that every fence is
// a requirement, not a comment, so it is asserted here. Each matcher is proved
// against known-bad text below, so a pattern that silently stops matching fails
// here instead of shipping.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPTS = join(REPO_ROOT, 'scripts');

const POLICY_SCRIPTS = ['check-vsix-smoke.mjs', 'check-build-freshness.mjs'] as const;
const ALL_PACKAGING_SCRIPTS = [...POLICY_SCRIPTS, 'package-vsix-smoke.mjs'] as const;

/** `--update`, `--write`, `--fix`, `--overwrite`, and their short forms. */
const UPDATE_FLAG = /(^|[^\w-])(--(update|write|fix|overwrite|regenerate)|-[uwf])(\b|=)/;
/** Any `process.argv` read other than `[1]` (script name) and `[2]` (the VSIX path). */
const ARGV_READ = /process\.argv(?!\[[12]\])/;
/** Filesystem calls that create, change, or remove something. */
const FS_WRITE =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|utimes|utimesSync|chmod|chmodSync)\s*\(/;

function read(name: string): string {
  return readFileSync(join(SCRIPTS, name), 'utf8');
}

/** Source lines only — a matcher that fires on its own prose proves nothing. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}

describe('the packaging gates cannot be made green by a tool (FR-012)', () => {
  it.each(ALL_PACKAGING_SCRIPTS)('%s parses no update flag', (name) => {
    const offending = codeLines(read(name)).filter((line) => UPDATE_FLAG.test(line));
    expect(offending).toEqual([]);
  });

  it.each(ALL_PACKAGING_SCRIPTS)('%s reads no argv beyond the positional path', (name) => {
    const offending = codeLines(read(name)).filter((line) => ARGV_READ.test(line));
    expect(offending).toEqual([]);
  });

  it('the flag matcher matches an offending line', () => {
    expect(UPDATE_FLAG.test("if (process.argv.includes('--update')) rewriteAllowlist();")).toBe(true);
    expect(UPDATE_FLAG.test('const fix = args.has("--fix");')).toBe(true);
    expect(UPDATE_FLAG.test('run(["--write"])')).toBe(true);
    expect(UPDATE_FLAG.test('parse("-u")')).toBe(true);
    // And does not fire on the flags the release command legitimately carries.
    expect(UPDATE_FLAG.test("await run('vsce', ['package', '--no-dependencies', '--out', path]);")).toBe(
      false
    );
  });

  it('the argv matcher matches an offending line', () => {
    expect(ARGV_READ.test('const flags = process.argv.slice(2);')).toBe(true);
    expect(ARGV_READ.test('process.argv[3]')).toBe(true);
    expect(ARGV_READ.test("inspectVsix(process.argv[2] ?? 'schegent-smoke.vsix');")).toBe(false);
  });
});

describe('the policy gates do not repair what they refuse (FR-021)', () => {
  it.each(POLICY_SCRIPTS)('%s calls no filesystem write API', (name) => {
    const offending = codeLines(read(name)).filter((line) => FS_WRITE.test(line));
    expect(offending).toEqual([]);
  });

  it.each(POLICY_SCRIPTS)('%s imports no write API from node:fs', (name) => {
    const imports = read(name).match(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/);
    expect(imports).not.toBeNull();
    const named = (imports?.[1] ?? '').split(',').map((entry) => entry.trim());
    expect(named.filter((entry) => FS_WRITE.test(`${entry}(`))).toEqual([]);
    expect(named.length).toBeGreaterThan(0);
  });

  it('the write matcher matches an offending line', () => {
    expect(FS_WRITE.test('writeFileSync(target, JSON.stringify(entries));')).toBe(true);
    expect(FS_WRITE.test('  rmSync(stale, { recursive: true });')).toBe(true);
    expect(FS_WRITE.test('await mkdtemp(join(tmpdir(), "vsix-"));')).toBe(true);
    // The reads these scripts do make are not writes.
    expect(FS_WRITE.test("const zip = readFileSync(vsixPath);")).toBe(false);
    expect(FS_WRITE.test('for (const entry of readdirSync(dir, { withFileTypes: true })) {')).toBe(
      false
    );
    expect(FS_WRITE.test('stats = statSync(path);')).toBe(false);
  });

  it('package-vsix-smoke.mjs is the one script that does write, and only its own tempdir', () => {
    // Stated as an assertion so the exemption cannot silently widen: it may create
    // and remove a temporary directory, and nothing else.
    const lines = codeLines(read('package-vsix-smoke.mjs')).filter((line) => FS_WRITE.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/mkdtemp|\brm\b|rmSync/);
    }
  });
});
