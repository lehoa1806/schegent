// FR-R3-024 (FR-012, FR-014, FR-017) — the advisory/authoritative split in
// `WorkspaceLockManager`, enforced rather than described.
//
// `lock.ts` states the rule: `isHeld()` is synchronous and *advisory*, reading
// the per-host `Memento` mirror of the ownership record, for projection paths
// that cannot await; `hasPrimacy()` awaits `verifyClaim()` and is
// *authoritative*, carrying the fencing token issued at acquisition, for
// decisions. Six decision sites read the advisory predicate anyway.
//
// Today's mirror read happens to be safe — `writeGuarded` refreshes the
// ownership record before writing the mirror and short-circuits on a refused
// refresh, so the mirror can never be fresher than the record, and both the
// reclaim rule and `isHeld()`'s freshness check use the same
// `STALENESS_THRESHOLD_MS`. That is a property of statement order in two
// modules, required by no comment and, until FR-015, asserted by no test. It is
// not what the rule says, and a caller relying on it is relying on an accident.
//
// This gate holds the end state: no decision site reads the mirror, the one
// genuine projection consumer still does, and the handler-side gate cannot be
// applied without joining the list that declares it.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PRIMACY_GATED_READ_HANDLERS } from '../../src/ui/sidebar/commands/primacy-gate';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const COMMANDS_DIR = resolve(SRC_ROOT, 'ui', 'sidebar', 'commands');
const EXTENSION_PATH = resolve(SRC_ROOT, 'extension.ts');

/**
 * The two modules that DEFINE an `isHeld` member and may reference it: the
 * workspace lock itself, and the per-queue execution lease, whose
 * `isHeld(queueId)` is a different predicate about a different resource.
 *
 * Not an allowlist of tolerated call sites — there are none, which is why the
 * rewire covered all six rather than landing at one and tolerating five.
 */
const ISHELD_DEFINING_MODULES: ReadonlySet<string> = new Set([
  'src/state/lock.ts',
  'src/state/execution-lease.ts'
]);

function listTypeScriptFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listTypeScriptFiles(abs));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function rel(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

/**
 * Strips comments so a docblock that NAMES the forbidden predicate — several
 * do, on purpose, to record why it is forbidden — is not read as a call to it.
 * Line-oriented rather than a parse: full-line `//`, `/*`, `*` and `*&#47;`
 * lines go, and a trailing `//` on a code line is cut. A string literal
 * containing `//` would be truncated early; none of these files has one, and a
 * false negative there costs a scan line, not a gate.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*')
      ) {
        return '';
      }
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('the advisory/authoritative primacy split (FR-R3-024)', () => {
  it('no decision site in src/ reads the advisory mirror', () => {
    const offenders: string[] = [];
    for (const abs of listTypeScriptFiles(SRC_ROOT)) {
      const file = rel(abs);
      if (ISHELD_DEFINING_MODULES.has(file)) continue;
      const code = stripComments(readFileSync(abs, 'utf8'));
      // The leading dot keeps `isForeignLockHeld()` out of the match: it ends
      // in `Held(` but is not `.isHeld(`, and it is the one sanctioned
      // projection read.
      if (code.includes('.isHeld(')) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these files read lock.isHeld() — an advisory mirror read — where the authoritative hasPrimacy() belongs:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('scans a real tree, so a broken walk cannot pass vacuously', () => {
    expect(listTypeScriptFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it('keeps the one genuine projection consumer on the advisory predicate', () => {
    // FR-017 — `isForeignLockHeld()` is read by a synchronous projection path
    // that cannot await. Nothing here turns a projection into a decision.
    const src = readFileSync(EXTENSION_PATH, 'utf8');
    expect(src).toContain('isForeignLockHeld: () => lock.isForeignLockHeld()');
  });

  it('every primacy-gated read handler routes through the un-discardable gate', () => {
    expect(PRIMACY_GATED_READ_HANDLERS.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of PRIMACY_GATED_READ_HANDLERS) {
      const src = readFileSync(resolve(COMMANDS_DIR, name), 'utf8');
      if (!src.includes('withPrimary')) offenders.push(name);
    }
    expect(
      offenders,
      `listed as primacy-gated but not routed through withPrimary:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no handler calls a bare primacy predicate of its own', () => {
    // FR-008, FR-012 — one implementation. A handler that reads
    // `deps.isPrimary()` directly is back to holding a verdict it can drop,
    // which is the defect FR-R3-024 exists to remove.
    const offenders: string[] = [];
    for (const abs of listTypeScriptFiles(COMMANDS_DIR)) {
      const file = rel(abs);
      if (file.endsWith('/primacy-gate.ts') || file.endsWith('/router-types.ts')) continue;
      const code = stripComments(readFileSync(abs, 'utf8'));
      if (code.includes('isPrimary')) offenders.push(file);
    }
    expect(
      offenders,
      `these handlers reference isPrimary directly instead of importing withPrimary:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('keeps the gated read command out of the mutating set', () => {
    // FR-011 — `CMD_READ_METRICS` gates itself precisely because the router's
    // gate does not cover it. Adding it to MUTATING_COMMANDS would change the
    // rejection surface and the operator toast for a read.
    const metadata = readFileSync(
      resolve(SRC_ROOT, 'contracts', 'sidebar-command-metadata.ts'),
      'utf8'
    );
    expect(metadata).not.toContain('CMD_READ_METRICS');
  });
});
