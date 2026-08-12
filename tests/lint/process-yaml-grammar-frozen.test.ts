// Feature 086 T003 — the exchange grammar is frozen for the duration of this
// feature.
//
// Feature 086 adds a third document kind (`kind: Workflow`) and **no**
// production. Research R1 asserted that; the T001 gate in
// `tests/contract/process-yaml-grammar.test.ts` proves the deepest construct the
// Workflow kind needs — a condition literal list inside a connection item —
// parses under the grammar as it already stands. This file is the other half of
// that claim: the gate proves the grammar *suffices*, and this proves nobody
// *changed* it to make the gate pass.
//
// Why a content hash rather than a behavioral assertion: a widening does not
// have to break an existing test. Admitting one more shape leaves every
// currently-accepted document accepted and every pinned refusal refused, so the
// corpus stays green while the accepted language quietly grows. Only the bytes
// notice.
//
// ## Amendment protocol
//
// This test is meant to be *updated*, not worked around. A deliberate grammar
// change is legitimate — 085 made one. To make one:
//
//   1. Change the module.
//   2. Update the matching entry in `FROZEN` **in the same commit**, and put the
//      reason in that commit's message: which production moved, which spec
//      requirement authorized it, and which fixtures now cover it.
//   3. Add the fixtures. A widening without a new `accepted/<vintage>/` case is
//      a change to the accepted language with nothing pinning its new edge.
//
// An accidental edit — a refactor that drifts into the scanner, a "harmless"
// tidy-up, a merge that resolves the wrong way — fails here with no
// accompanying constant change, which is exactly the signal wanted. Do not
// regenerate the constants to make this pass; that turns the freeze into a
// rubber stamp.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXCHANGE_DIR = resolve(REPO_ROOT, 'src', 'services', 'process-yaml');

/**
 * The three modules that between them define the accepted language: the
 * tokenizer, the tree builder, and the scalar-style rule both consult.
 */
const FROZEN: ReadonlyMap<string, string> = new Map([
  // Moved by feature 091 (T028, FR-034): `readDoubleQuoted` now decides the
  // UTF-16 surrogate rule at the escape site, refusing a lone half as
  // `disallowed-syntax` while a well-formed pair stays legal. A narrowing, not a
  // widening — vintage 091 pins it with four `refused/` cases and one
  // `accepted/` case for the pair that must keep round-tripping byte-identical.
  ['yaml-scanner', 'a52994b8c3ad3d09e78d04ce1017b09fc375992acfcfdd05bb1c330d7eb8615d'],
  ['yaml-parser', '6536987fe243505f2caad0695fd59135c224162be1e84b893c3af058387ec1a0'],
  ['scalar-style', '5b48ed2a529feb85b808840d81c599162ecdeae0a2dac36720a0ed8c8e20cddf']
]);

function sourceOf(name: string): string {
  return resolve(EXCHANGE_DIR, `${name}.ts`);
}

/**
 * Hashes the file with CRLF normalized to LF. This repository has no
 * `.gitattributes`, so a checkout may rewrite line endings and a raw byte hash
 * would fail on a working tree nobody edited. Normalizing costs nothing the
 * freeze cares about: every real grammar change adds, removes, or alters a
 * character that is not a carriage return.
 */
function grammarDigest(name: string): string {
  const text = readFileSync(sourceOf(name), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * `types.ts` is in the closure and is deliberately **not** frozen: it is a
 * declaration module that 086 must extend with the Workflow document shapes.
 * Exactly one value crosses from it into the grammar — the size bound the
 * parser checks before it scans — and that is pinned below, so a production
 * migrating into `types.ts` cannot hide there.
 */
const DECLARATIONS = 'types';
const DECLARED_VALUES = ['PHASE_YAML_MAX_BYTES'] as const;

const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(type\s+)?([\s\S]*?)from\s+'(\.[^']+)'/g;

interface RelativeImport {
  readonly specifier: string;
  /** Bindings that survive compilation. Empty for an erased import. */
  readonly values: readonly string[];
}

function relativeImportsOf(file: string): readonly RelativeImport[] {
  const found: RelativeImport[] = [];
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)) {
    const values = match[1]
      ? []
      : (match[2] ?? '')
          .replace(/[{}]/g, '')
          .split(',')
          .map((binding) => binding.trim())
          .filter((binding) => binding.length > 0 && !binding.startsWith('type '));
    found.push({ specifier: match[3]!, values });
  }
  return found;
}

/** Every module under the exchange directory reachable through value imports. */
function grammarClosure(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [sourceOf(entry)];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const entryImport of relativeImportsOf(file)) {
      // An erased import cannot carry a production.
      if (entryImport.values.length === 0) continue;
      const target = resolve(dirname(file), `${entryImport.specifier}.ts`);
      // An unresolvable specifier would silently shrink the closure and let the
      // completeness check below pass for the wrong reason.
      expect(existsSync(target), `${relative(REPO_ROOT, file)} imports unresolvable ${entryImport.specifier}`).toBe(
        true
      );
      pending.push(target);
    }
  }

  return new Set([...visited].map((file) => relative(EXCHANGE_DIR, file).replace(/\.ts$/, '')));
}

describe('Feature 086 T003 — the accepted language did not move', () => {
  it.each([...FROZEN.keys()])('%s.ts matches its pinned digest', (name) => {
    expect(existsSync(sourceOf(name)), `${name}.ts is missing — see the amendment protocol`).toBe(true);
    expect(grammarDigest(name)).toBe(FROZEN.get(name));
  });

  it('freezes every module the grammar is actually made of', () => {
    // Pinning three files is only a freeze if three files are all there is. A
    // refactor that lifts a production into a fourth module would otherwise
    // leave that production unpinned while all three digests still matched, so
    // the frozen set is checked against what `yaml-parser` really reaches
    // rather than against a list someone remembered to update.
    expect([...grammarClosure('yaml-parser')].sort()).toEqual([...FROZEN.keys(), DECLARATIONS].sort());
  });

  it('takes nothing from the unfrozen declaration module but the size bound', () => {
    // The one hole in the freeze, held to one constant. `types.ts` grows this
    // feature; if a production ever moved into it, something other than
    // `PHASE_YAML_MAX_BYTES` would have to cross, and this fails.
    const crossings = [...FROZEN.keys()].flatMap((name) =>
      relativeImportsOf(sourceOf(name))
        .filter((entry) => entry.specifier === `./${DECLARATIONS}`)
        .flatMap((entry) => entry.values)
    );
    expect([...new Set(crossings)].sort()).toEqual([...DECLARED_VALUES].sort());
  });
});
