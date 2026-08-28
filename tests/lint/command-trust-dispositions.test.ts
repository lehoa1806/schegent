// FR-R3-136 (FR-002, FR-003, FR-004) — every registered command carries a trust
// disposition, and nothing registers a command outside the guarded helper.
//
// WHAT THIS GATE IS FOR. The defect it closes was not a missing check in one
// handler; it was a whole surface with no classification. Thirty
// `vscode.commands.registerCommand` calls reached mutating services and none of
// them consulted Workspace Trust, while the sidebar's IPC surface — the other way
// to reach the same services — had been classified and refused since Feature 059.
// Fixing the thirty call sites without a gate would leave the thirty-first
// unguarded, which is the shape of the original defect.
//
// FOUR DIRECTIONS, BECAUSE THREE OF THEM PASS VACUOUSLY ALONE. "Every declared id
// is registered" is satisfied by declaring nothing. "Every registered id is
// declared" is satisfied by registering nothing. "No raw registration exists" is
// satisfied by an empty scan. Held together, and against the manifest, each one's
// vacuous case is another one's failure.
//
// PLUS TWO CONTROLS. `FR-R3-135` closed a parity check that proved two fields
// agreed while proving nothing about what ran, and the lesson taken from it was
// that a gate needs a demonstration it can fail. So the throw is driven with an
// unclassified id, and the raw-registration detector is driven against a synthetic
// source that contains one.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { filesUnder } from './source-scan';
// Only the pure contracts module is imported. `FR-R3-126`: "a gate whose
// dependency graph reaches `vscode` can fail for reasons that have nothing to do
// with what it checks" — which is why `requireDisposition` and its error live in
// `src/contracts/` rather than beside `registerGuardedCommand`.
import {
  MUTATING_COMMAND_IDS,
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_IDS,
  READ_ONLY_COMMAND_ID_LIST,
  UnclassifiedCommandError,
  lookupDisposition,
  requireDisposition
} from '../../src/contracts/entry-point-dispositions';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

/**
 * The one module allowed to call `vscode.commands.registerCommand`, as a
 * repo-relative path. Everything else must go through `registerGuardedCommand`.
 */
const HELPER_MODULE = 'src/activation/guarded-command-registration.ts';

const relative = (abs: string): string =>
  abs.slice(REPO_ROOT.length + 1).split('\\').join('/');

/**
 * Call sites of the raw VS Code API, as `path:line` strings.
 *
 * A named function taking the source text rather than an inline scan, so the
 * control below can drive it against a synthetic file it fully controls. A
 * detector that can only be run over the real tree cannot be shown to detect
 * anything.
 */
export function rawRegistrationsIn(relPath: string, source: string): string[] {
  const out: string[] = [];
  source.split('\n').forEach((line, index) => {
    if (line.includes('vscode.commands.registerCommand(')) {
      out.push(`${relPath}:${index + 1}`);
    }
  });
  return out;
}

/**
 * Ids passed to `registerGuardedCommand`, from the source text.
 *
 * THIS IS A BRACE-BALANCED SCAN AND NOT A REGEX, and the first version was the
 * regex. `/registerGuardedCommand\(\s*[^,]+,\s*'([^']+)'/` found 29 of the 30
 * because the thirtieth passes its deps as an inline object literal, whose commas
 * ended the `[^,]+` run early. Hoisting that literal into a named const would have
 * made the regex pass, which is the wrong repair: a gate that a caller's
 * FORMATTING can silently switch off is worse than no gate, because the 29 hits
 * make it look like it is working.
 *
 * So the first argument is skipped by balancing delimiters to the first top-level
 * comma, whatever its shape.
 */
export function guardedIdsIn(source: string): string[] {
  const CALL = 'registerGuardedCommand(';
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(CALL, from);
    if (start === -1) return out;
    let i = start + CALL.length;
    let depth = 0;
    let quote: string | null = null;
    // Walk to the first comma at depth 0 — the end of the deps argument.
    for (; i < source.length; i += 1) {
      const ch = source[i]!;
      if (quote !== null) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break; // the call closed with no second argument
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
    }
    const id = /^\s*,\s*'([^']+)'/.exec(source.slice(i));
    if (id) out.push(id[1]!);
    from = start + CALL.length;
  }
}

const sourceFiles = filesUnder(SRC_ROOT, { extensions: ['.ts'] });

const registeredIds = new Set<string>();
const rawSites: string[] = [];
for (const abs of sourceFiles) {
  const rel = relative(abs);
  const text = readFileSync(abs, 'utf8');
  guardedIdsIn(text).forEach((id) => registeredIds.add(id));
  if (rel !== HELPER_MODULE) rawSites.push(...rawRegistrationsIn(rel, text));
}

interface ManifestCommand {
  readonly command: string;
}

function contributedCommands(): readonly ManifestCommand[] {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes?: { commands?: readonly ManifestCommand[] };
  };
  return manifest.contributes?.commands ?? [];
}

describe('FR-R3-136 — every command entry point carries a trust disposition, and mutating ones are guarded', () => {
  it('the scan found a source tree and a populated inventory', () => {
    // The guard on every "no offenders" assertion below. Without it, a broken
    // scan root reports a clean tree.
    expect(sourceFiles.length, 'the source walk found nothing').toBeGreaterThan(200);
    expect(registeredIds.size, 'no guarded registrations were found').toBeGreaterThan(25);
    expect(MUTATING_COMMAND_ID_LIST.length).toBeGreaterThan(15);
    expect(READ_ONLY_COMMAND_ID_LIST.length).toBeGreaterThan(3);
  });

  it('no module outside the helper calls vscode.commands.registerCommand', () => {
    expect(
      rawSites,
      'These call sites bypass the trust guard. Register through ' +
        '`registerGuardedCommand` from ' +
        `${HELPER_MODULE} instead (FR-R3-136, FR-003).`
    ).toEqual([]);
  });

  it('every declared id is actually registered', () => {
    const declared = [...MUTATING_COMMAND_ID_LIST, ...READ_ONLY_COMMAND_ID_LIST];
    const orphans = declared.filter((id) => !registeredIds.has(id));
    expect(
      orphans,
      'These ids carry a disposition but no registration. Either the command was ' +
        'removed and its entry should go, or the registration was missed.'
    ).toEqual([]);
  });

  it('every registered id carries a disposition', () => {
    const unclassified = [...registeredIds].filter((id) => lookupDisposition(id) === null);
    expect(
      unclassified,
      'These ids are registered with no entry in MUTATING_COMMAND_IDS or ' +
        'READ_ONLY_COMMAND_IDS. Classify each one against the criterion recorded ' +
        'in src/contracts/entry-point-dispositions.ts beside the two maps'
    ).toEqual([]);
  });

  it('every contributed palette command carries a disposition', () => {
    // The manifest is the surface an operator can reach from the palette, so a
    // contributed command with no disposition is the case that matters most —
    // and it is a different set from the registrations, because 22 of the 30 are
    // contributed and the rest are registered-only.
    const contributed = contributedCommands();
    expect(contributed.length, 'the manifest declares no commands').toBeGreaterThan(15);
    const unclassified = contributed
      .map((c) => c.command)
      .filter((id) => lookupDisposition(id) === null);
    expect(
      unclassified,
      'These palette commands have no trust disposition, so an untrusted window ' +
        'would run them unguarded (FR-R3-136, FR-004).'
    ).toEqual([]);
  });

  it('no id is in both maps', () => {
    const both = MUTATING_COMMAND_ID_LIST.filter((id) =>
      Object.prototype.hasOwnProperty.call(READ_ONLY_COMMAND_IDS, id)
    );
    expect(both, 'an id with two dispositions has none').toEqual([]);
  });

  it('every reason is a non-empty description, not a restated id', () => {
    // A reason reaches the operator in the refusal message, so "schegent.enqueue
    // is unavailable (schegent.enqueue)" would be a working gate around a useless
    // message.
    const bad = Object.entries({ ...MUTATING_COMMAND_IDS, ...READ_ONLY_COMMAND_IDS }).filter(
      ([id, reason]) => reason.trim().length < 4 || reason.includes(id)
    );
    expect(bad.map(([id]) => id)).toEqual([]);
  });

  // ---- controls: the gate's own failure modes, demonstrated ----

  it('CONTROL: an unclassified id throws, and a classified one does not', () => {
    // `requireDisposition` is what `registerGuardedCommand` calls before it
    // touches the VS Code API, so driving it here proves the registration path
    // fails closed without importing `vscode` into a lint gate.
    expect(() => requireDisposition('schegent.noSuchCommandForThisControl')).toThrow(
      UnclassifiedCommandError
    );
    expect(requireDisposition('schegent.enqueue')).toEqual({
      disposition: 'mutating',
      reason: 'queue enqueue'
    });
    expect(requireDisposition('schegent.showAuditLog').disposition).toBe('read-only');
  });

  it('CONTROL: the raw-registration detector finds one in a synthetic source', () => {
    const synthetic = [
      'const a = 1;',
      "vscode.commands.registerCommand('schegent.bypass', () => undefined);",
      'const b = 2;'
    ].join('\n');
    expect(rawRegistrationsIn('synthetic.ts', synthetic)).toEqual(['synthetic.ts:2']);
    // And spares a file that has none, so it is shown to discriminate rather
        // than to report everything.
    expect(rawRegistrationsIn('synthetic.ts', 'const a = 1;\n')).toEqual([]);
  });

  it('CONTROL: the id extractor reads every call shape in the tree, including the one that broke the regex', () => {
    const named = "registerGuardedCommand(deps, 'schegent.inline', () => undefined)";
    const wrapped = [
      'registerGuardedCommand(',
      '  deps,',
      "  'schegent.wrapped',",
      '  () => undefined',
      ')'
    ].join('\n');
    // The shape that found 29 of 30: an inline object literal whose commas ended
    // the regex's first-argument run. This is the assertion that stops the gate
    // from being switched off by a caller's formatting.
    const inlineLiteral = [
      'registerGuardedCommand(',
      '  { isWorkspaceTrusted: () => true, notifier, logger },',
      "  'schegent.literalDeps',",
      '  handler',
      ')'
    ].join('\n');
    expect(guardedIdsIn(named)).toEqual(['schegent.inline']);
    expect(guardedIdsIn(wrapped)).toEqual(['schegent.wrapped']);
    expect(guardedIdsIn(inlineLiteral)).toEqual(['schegent.literalDeps']);
    // A nested call in the deps argument must not confuse the depth walk.
    expect(
      guardedIdsIn("registerGuardedCommand(makeDeps(a, b), 'schegent.nested', h)")
    ).toEqual(['schegent.nested']);
    // A comma inside a string in the deps argument must not either.
    expect(
      guardedIdsIn("registerGuardedCommand({ tag: 'a,b' }, 'schegent.quoted', h)")
    ).toEqual(['schegent.quoted']);
    // And it reports nothing when the id is not a literal, rather than guessing.
    expect(guardedIdsIn('registerGuardedCommand(deps, someVariable, handler)')).toEqual([]);
    expect(guardedIdsIn('const x = 1;')).toEqual([]);
  });
});
