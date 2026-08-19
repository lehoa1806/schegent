// Feature FR-R3-005 (T330) — there is exactly one oracle, and every
// destructive filesystem call in the host consults it.
//
// The finding this closes was never "one path was unguarded". It was that
// containment lived as a private function inside one service, so every other
// site that assembled a path lexically was an independent opportunity to
// forget — and several had. Extracting `src/lib/path-containment.ts` fixes the
// sites that exist today; it does nothing about the next `fs.rm` someone adds.
// That is what this gate is for.
//
// The failure it catches is invisible to every other check. An unguarded
// `fs.rm(path.join(root, name))` typechecks, passes its unit tests, and behaves
// correctly on every developer machine — because none of them has a symlink
// planted in the directory. It misbehaves only on a workspace laid out to make
// it misbehave, which is precisely the case a test suite cannot enumerate. So
// the guard is pinned as a shape rule on the source.
//
// Four rules, each naming the specific regression it forbids:
//
//   1. Exactly one oracle. Only `path-containment.ts` may pair a `realpath`
//      with a `path.relative` — that pairing *is* a containment check, and a
//      second copy of it is a second policy that drifts from the first.
//   2. Every destructive call establishes containment first. `rm`, `rmdir`,
//      `unlink`, `rename` and `truncate` must be preceded, within a bounded
//      window in the same file, by something that proves the path.
//   3. A file that mutates the filesystem destructively imports the oracle.
//      Rule 2 reads names; this one reads the import, so a file cannot satisfy
//      the marker rule with an identifier that merely spells "contained".
//   4. Production wires the runtime-log sink's roots. The sink's containment is
//      opt-in at construction so the seven existing sink test files keep
//      building with two arguments; that makes the single production call site
//      load-bearing in exactly the way `ownership-registry-wiring.test.ts`
//      describes — omit it and every test still passes.
//
// Scope is `src/`. Tests remove their own fixtures constantly and are meant to;
// `webview-ui/` has no filesystem.

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(REPO_ROOT, 'src');

const ORACLE = 'src/lib/path-containment.ts';
const BACKEND_WIRING = 'src/activation/backend-wiring.ts';

/** The calls that destroy or relocate something already on disk. */
const DESTRUCTIVE = /\.\s*(rm|rmdir|unlink|rename|truncate)\s*\(/g;

/**
 * How far above a destructive call the proof may sit.
 *
 * Wide enough for the longest real guard today — the retention sweep, whose
 * verdict is taken 16 lines before its `rm` with the skip and the `gone` case
 * in between — and narrow enough that a proof in a neighbouring method cannot
 * be mistaken for this one's. It is a proximity heuristic, not a dataflow
 * analysis: it cannot prove the guarded path is the removed path, only that
 * whoever wrote the call was looking at containment while they wrote it.
 */
const PROOF_WINDOW_LINES = 25;

/**
 * What counts as proof: the word itself, anywhere in the window. That covers
 * the oracle's three entry points and every helper whose name carries it —
 * `removeIfContained`, `rotationPathIsContained`, `proveContainedEntry`,
 * `candidateContainmentVerdict`. Naming the guard for what it does is the
 * convention this rule enforces, and it is why those helpers are named that
 * way rather than the gate keeping a list of them that goes stale.
 */
const PROOF = /[Cc]ontain/;

/**
 * Destructive calls that legitimately have no path to prove, each with the
 * reason. This list should stay short; an entry is a recorded decision, and a
 * long one would mean the rule had stopped describing the codebase.
 */
const ALLOWLIST: readonly { readonly file: string; readonly call: string; readonly why: string }[] =
  [
    {
      file: 'src/audit/raw-transcript-writer.ts',
      call: 'destination.truncate(',
      why:
        'FileHandle.truncate names no path. The handle was opened through the ' +
        'guarded write path, so containment is already proven and re-proving ' +
        'it here would check a different thing than the one being truncated.'
    }
  ];

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/** Blank out comments, preserving offsets so line numbers still line up. */
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '//') {
      const newline = text.indexOf('\n', cursor);
      const stop = newline === -1 ? text.length : newline;
      blank(cursor, stop);
      cursor = stop;
    } else if (pair === '/*') {
      const close = text.indexOf('*/', cursor + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(cursor, stop);
      cursor = stop;
    } else {
      cursor += 1;
    }
  }
  return out.join('');
}

function tsFilesUnder(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly proven: boolean;
}

/**
 * Every destructive call in `src/`, with whether containment was established
 * in the lines above it. Comments are blanked first: the oracle's own header
 * names all five operations, and so do several of the guards' explanations.
 */
function destructiveCallSites(): readonly CallSite[] {
  const sites: CallSite[] = [];
  for (const full of tsFilesUnder(SRC)) {
    const file = relative(REPO_ROOT, full).split('\\').join('/');
    const lines = stripComments(read(file)).split('\n');
    lines.forEach((text, index) => {
      DESTRUCTIVE.lastIndex = 0;
      if (!DESTRUCTIVE.test(text)) return;
      const from = Math.max(0, index - PROOF_WINDOW_LINES);
      const window = lines.slice(from, index + 1).join('\n');
      sites.push({ file, line: index + 1, text: text.trim(), proven: PROOF.test(window) });
    });
  }
  return sites;
}

function isAllowlisted(site: CallSite): boolean {
  return ALLOWLIST.some((entry) => entry.file === site.file && site.text.includes(entry.call));
}

const SITES = destructiveCallSites();

describe('FR-R3-005 — destructive filesystem calls route through the containment oracle', () => {
  it('finds the destructive calls it is meant to be checking', () => {
    // A regex that silently stopped matching would make every rule below pass
    // vacuously, which is the one way this gate could fail open.
    expect(
      SITES.length,
      'the destructive-call scan matched nothing; the pattern or the tree walk is broken'
    ).toBeGreaterThan(5);
    expect(
      [...new Set(SITES.map((site) => site.file))].length,
      'destructive calls are expected across several subsystems'
    ).toBeGreaterThan(2);
  });

  it('keeps exactly one oracle: nobody else pairs realpath with path.relative', () => {
    const offenders = tsFilesUnder(SRC)
      .map((full) => relative(REPO_ROOT, full).split('\\').join('/'))
      .filter((file) => file !== ORACLE)
      .filter((file) => {
        const source = stripComments(read(file));
        return /\brealpath\s*\(/.test(source) && /\bpath\.relative\s*\(/.test(source);
      });
    expect(
      offenders,
      `only ${ORACLE} may decide containment; a second realpath/relative pairing is ` +
        'a second policy, and the two drift silently because both look correct'
    ).toEqual([]);
  });

  it('proves containment before every destructive call', () => {
    const unproven = SITES.filter((site) => !site.proven && !isAllowlisted(site)).map(
      (site) => `${site.file}:${site.line} ${site.text}`
    );
    expect(
      unproven,
      'each of these destroys or relocates a path without establishing containment ' +
        `within ${PROOF_WINDOW_LINES} lines above it; route it through ` +
        `${ORACLE} (resolveContainedTarget / resolveContainedLink / ` +
        'resolveContainedForWrite) and act on the resolved path'
    ).toEqual([]);
  });

  it('imports the oracle in every file that mutates destructively', () => {
    const files = [...new Set(SITES.filter((site) => !isAllowlisted(site)).map((s) => s.file))];
    const missing = files.filter(
      (file) => file !== ORACLE && !/from '[^']*path-containment'/.test(stripComments(read(file)))
    );
    expect(
      missing,
      'a file with a destructive call must import the oracle; passing the marker ' +
        'rule on an identifier that merely spells "contained" is not a guard'
    ).toEqual([]);
  });

  it('keeps every allowlist entry pointing at a call that still exists', () => {
    const stale = ALLOWLIST.filter(
      (entry) => !stripComments(read(entry.file)).includes(entry.call)
    ).map((entry) => `${entry.file} ${entry.call}`);
    expect(stale, 'an allowlist entry for a call that is gone is a recorded hole with no hole')
      .toEqual([]);
  });

  it('wires the runtime-log sink containment roots in production', () => {
    // The sink takes its roots optionally so the existing sink test files keep
    // constructing it with two arguments. That makes this one call site the
    // whole of the production guarantee: drop it and the sink silently returns
    // to writing wherever the lexical accessor admitted, with no test failing.
    const source = stripComments(read(BACKEND_WIRING));
    const construction = /new RuntimeLogSink\s*\(([\s\S]*?)\}\s*\)/.exec(source);
    expect(construction, `${BACKEND_WIRING} must construct the RuntimeLogSink`).not.toBeNull();
    expect(
      construction![1]!,
      `${BACKEND_WIRING} must pass containmentRoots to the sink`
    ).toContain('containmentRoots');
    // The accessor and the sink must read one list. Two derivations are two
    // policies, and the gap between them is a path that passes admission and is
    // then refused at the point of effect, or the other way around.
    expect(
      (source.match(/allowedRuntimeLogRoots/g) ?? []).length,
      `${BACKEND_WIRING} must share one root list between the accessor and the sink`
    ).toBeGreaterThanOrEqual(3);
  });

  it('roots the ownership adapter in the directory the registry writes to', () => {
    // `createDiskOwnershipFs` proves its renames and removes against the root
    // it was handed. Handing it one and the registry another would guard a tree
    // nothing is written to, which reads as a working guard.
    const source = stripComments(read('src/extension.ts'));
    const call = /useOwnershipStorage\s*\(([\s\S]*?)\)\s*;/.exec(source);
    expect(call, 'the useOwnershipStorage call must be readable').not.toBeNull();
    expect(
      /createDiskOwnershipFs\s*\(\s*(\w+)\s*\)\s*,\s*\1\s*$/.test(call![1]!.trim()),
      'createDiskOwnershipFs must be rooted at the same directory passed to ' +
        'useOwnershipStorage; a different root guards a tree nothing writes to'
    ).toBe(true);
  });
});
