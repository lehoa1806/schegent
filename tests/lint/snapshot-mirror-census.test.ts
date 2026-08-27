// FR-R3-132 (T1502, FR-001) — the webview's snapshot types are IMPORTED, not
// retyped, wherever the shape is not the webview's own decision.
//
// WHAT WAS MEASURED, because the item asked for a measurement before a change.
// `webview-ui/src/lib/snapshot-types.ts` held 97 declarations over 1,497 lines.
// Compared name-by-name against every declaration under `src/contracts/`,
// `src/state/` and `src/ui/`, with comments and whitespace normalised away:
//
//   51 declarations (315 lines) were BYTE-IDENTICAL to a host declaration
//   20 shared a name with a different body
//   26 had no host counterpart at all
//
// The 51 were mechanical: nothing decided anything, a copy was kept in step by
// hand. 24 of them lived in `src/ui/sidebar/snapshot.ts` — outside
// `src/contracts/` — which is WHY they were copied rather than imported, since
// `webview-host-import-direction.test.ts` pins the boundary at `contracts/`. They
// moved to `src/contracts/snapshot-projections.ts`, where they belong on the
// merits, and the mirror re-exports the types.
//
// AND ONE OF THE TWENTY WAS A LIVE DEFECT, which is the argument for this gate
// existing rather than for the parity tests being trusted: the mirror's
// `QueueSummary.pauseSource` was `'operator' | 'cascade' | null` while the host's
// was `'operator' | 'cascade' | 'retry-cap' | null`. The host can send
// `'retry-cap'`; the webview's type said that value could not exist. No parity
// test covered it. So this gate does two things — it holds the identical count at
// zero, and it checks every union the mirror still restates by hand as a SUPERSET
// of the host union it mirrors.
//
// WHAT IS DELIBERATELY LEFT. Three classes stay hand-written and each says so at
// its declaration: optionality widened at the receiver (a webview must render a
// snapshot from a host one version behind), the `Portable*` editor shapes (a
// different concept that merely shared a name), and the 26 webview-local ones.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MIRROR = 'webview-ui/src/lib/snapshot-types.ts';
/**
 * The host tree this gate compares against.
 *
 * `src/services` WAS MISSING from a first version, and a review found the exact
 * duplication that let through: `EvidenceSinkStatus`, `EvidenceOverallStatus`,
 * `EvidenceContinuationPolicy` and `EvidenceSinkHealth` are byte-identical to
 * declarations in `src/services/evidence-health/evidence-health-monitor.ts`, and
 * the census reported all four as "webview-local". A gate that polices copies
 * while looking at three of a dozen directories reports a number, not a fact —
 * so the roots are now every directory under `src/` that declares types, with
 * `filesUnder` doing the walking.
 */
const HOST_ROOTS = ['src'] as const;

/**
 * Byte-identical mirrored declarations permitted in the mirror.
 *
 * SHRINK-ONLY, no raise path — the same discipline as
 * `drive-loop-loc-budget.test.ts` and `a11y-baseline-shrinks.test.ts`. A shape
 * both sides must agree on is imported; a shape the webview decides is the
 * webview's, and is not identical to anything.
 */
const MAX_IDENTICAL_MIRRORS = 0;

/**
 * Copies the structural check permits, each with the reason. Dated per FR-109.
 *
 * A NAME-KEYED CENSUS CANNOT SEE A RENAMED COPY, which is why this second check
 * exists at all. The first pass found 51 by name; fixing the two drifted
 * declarations made five MORE identical (a copy whose only difference was the
 * defect does not look like a copy until the defect is fixed), and comparing
 * structure with the declaration's own name blanked out found three the name
 * lookup could never have found — `PortablePipelineDefinition` IS host
 * `PipelineDefinition`, under the webview's word for it.
 */
const PERMITTED_COPIES: ReadonlyArray<{ readonly mirror: string; readonly reason: string }> = [
  // `BuilderLifecycle` was here, excused because its `changes` field is a
  // `ChangedFieldSummary` from `src/catalog/` and `contracts/` is a leaf layer.
  // Widening this gate's walk from three directories to the whole host tree found
  // `ChangedFieldSummary` itself duplicated, moved it into
  // `src/contracts/snapshot-vocabulary.ts`, and the blocker dissolved. The entry
  // was deleted rather than left to describe a constraint that had stopped
  // existing — which is the failure mode an allowlist has.
  {
    mirror: 'CatalogVersionRef',
    reason:
      '2026-08-28 — structurally equal to `CatalogCollectableRecord` by coincidence: both are ' +
      '`{ kind, id, versionId }`. They are different concepts and deduplicating them would ' +
      'couple a version pointer to a collection record'
  },
  {
    mirror: 'WorkflowCatalogPortProjection',
    reason:
      '2026-08-28 — the same coincidence as above against `WorkflowDerivedPort`: a two-field ' +
      'shape that two unrelated concepts happen to share'
  }
];

/** The declaration with its own name blanked, so a rename is not a disguise. */
function structuralKey(name: string, body: string): string {
  return normalize(body)
    .replace(new RegExp(`\\b${name}\\b`, 'g'), '_')
    .replace(/^export (?:interface|type) _ =? ?/, '');
}

interface Declaration {
  readonly name: string;
  readonly body: string;
  readonly file: string;
  readonly lines: number;
}

/** Comments and whitespace away: two declarations differ or they do not. */
function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/;\s*/g, ';')
    .trim();
}

function declarationsIn(relativePath: string): readonly Declaration[] {
  const text = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  const source = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const found: Declaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const body = text.slice(node.getStart(source, false), node.getEnd());
      found.push({
        name: node.name.text,
        body,
        file: relativePath,
        lines: body.split('\n').length
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every host declaration, first definition wins. */
function hostDeclarations(): ReadonlyMap<string, Declaration> {
  const byName = new Map<string, Declaration>();
  for (const root of HOST_ROOTS) {
    for (const absolute of filesUnder(resolve(REPO_ROOT, root), { extensions: ['.ts'] })) {
      const rel = relative(REPO_ROOT, absolute);
      if (rel.endsWith('.d.ts')) continue;
      for (const declaration of declarationsIn(rel)) {
        if (!byName.has(declaration.name)) byName.set(declaration.name, declaration);
      }
    }
  }
  return byName;
}

/**
 * The string-literal members of a declaration, or null when it has none.
 *
 * NORMALIZED FIRST, which a draft of this gate did not do — and the false positive
 * it produced is worth keeping in the record. The host's `QueueProjection` carries
 * a JSDoc block quoting `'migration-default'`, `'pending'` and `'dismissed'`, and
 * an un-normalized scan read prose as type members: the gate reported three
 * "missing" values that were never in either type. A comparison that reads
 * comments is comparing documentation.
 */
function unionMembers(rawBody: string): ReadonlySet<string> | null {
  const body = normalize(rawBody);
  // No capture group and no indexed access: the quotes are stripped from the whole
  // match instead. A capture group would need an `undefined` guard that
  // `noUncheckedIndexedAccess` requires and `no-unnecessary-condition` calls dead.
  const members = new Set(
    (body.match(/'[^']*'/g) ?? [])
      .map((quoted) => quoted.slice(1, -1))
      // Module specifiers are not union members. `import('../state/workflow-run')`
      // type references live inside declaration bodies, and a first version read
      // one as a missing member of `GeneralSettings`.
      .filter((value) => !value.includes('/') && !value.startsWith('.'))
  );
  return members.size === 0 ? null : members;
}

describe('FR-R3-132 — the snapshot mirror imports what it does not decide', () => {
  const mirror = declarationsIn(MIRROR);
  const host = hostDeclarations();

  it('has a mirror and a host tree to compare — the control', () => {
    // Without this the two loops below are vacuous: an empty mirror has no
    // identical declarations and no drifted unions, and this gate would report
    // green on a deleted file. The floors are the measured figures with room to
    // move, not the figures themselves.
    expect(mirror.length, `no declarations parsed from ${MIRROR}`).toBeGreaterThan(20);
    expect(host.size, 'no host declarations parsed').toBeGreaterThan(200);
  });

  it('restates no host declaration verbatim', () => {
    const permitted = new Set(PERMITTED_COPIES.map((entry) => entry.mirror));
    const identical = mirror.filter((declaration) => {
      if (permitted.has(declaration.name)) return false;
      const counterpart = host.get(declaration.name);
      return counterpart !== undefined && normalize(declaration.body) === normalize(counterpart.body);
    });

    const local = mirror.filter((d) => !host.has(d.name)).length;
    process.stdout.write(
      `\n[mirror] ${MIRROR}: ${mirror.length} declaration(s) — ${identical.length} identical to a ` +
        `host declaration, ${mirror.length - identical.length - local} deliberately different, ` +
        `${local} webview-local (ceiling ${MAX_IDENTICAL_MIRRORS})\n`
    );

    expect(
      identical.map((d) => `${d.name} (${d.lines} lines, mirrors ${host.get(d.name)?.file ?? '?'})`),
      'These declarations are byte-identical to a host declaration. Re-export the type instead of ' +
        'restating it: `export type { X } from \'...\'` is erased at compile time, so nothing ' +
        'reaches the webview bundle, and a copy kept in step by hand is how QueueSummary lost ' +
        "'retry-cap'. If the shape is genuinely the webview's own decision, make the difference " +
        'real and say why at the declaration.'
    ).toEqual([]);

    // Shrink-only: no slack for the next copy to land in silently.
    expect(MAX_IDENTICAL_MIRRORS - identical.length).toBeLessThanOrEqual(0);
  });

  it('restates no host declaration under a different name', () => {
    // The check the first pass could not make. Short keys are excluded: a
    // two-field shape that two unrelated concepts share is a coincidence, and
    // deduplicating a coincidence couples things that should not be coupled.
    const MIN_KEY_LENGTH = 60;
    const byStructure = new Map<string, Declaration>();
    for (const [, declaration] of host) {
      const key = structuralKey(declaration.name, declaration.body);
      if (key.length >= MIN_KEY_LENGTH && !byStructure.has(key)) byStructure.set(key, declaration);
    }

    const permitted = new Set(PERMITTED_COPIES.map((entry) => entry.mirror));
    const copies: string[] = [];
    for (const declaration of mirror) {
      const key = structuralKey(declaration.name, declaration.body);
      if (key.length < MIN_KEY_LENGTH) continue;
      const counterpart = byStructure.get(key);
      if (counterpart === undefined || permitted.has(declaration.name)) continue;
      copies.push(`${declaration.name} is ${counterpart.name} from ${counterpart.file}`);
    }

    expect(
      copies,
      'These declarations are structurally identical to a host declaration under a different ' +
        'name — the shape a name-keyed comparison cannot see. Re-export with an alias: ' +
        "`export type { PipelineDefinition as PortablePipelineDefinition } from '...'` keeps the " +
        'webview\'s word and deletes the copy. If the equality is a coincidence between ' +
        'unrelated concepts, add it to PERMITTED_COPIES with the reason.'
    ).toEqual([]);

    // The control: the comparison must have found the structures it permits, or
    // the allowlist is describing declarations this check no longer reaches.
    for (const entry of PERMITTED_COPIES) {
      expect(
        mirror.some((declaration) => declaration.name === entry.mirror),
        `PERMITTED_COPIES names ${entry.mirror}, which is no longer declared in ${MIRROR}. ` +
          'Remove the entry: an allowlist that outlives its subject is how the next real copy ' +
          'gets waved through.'
      ).toBe(true);
    }
  });

  it('restates no host union with a member missing', () => {
    // The half that catches F1's shape. A hand-written union in the mirror may be
    // NARROWER in name only — the host's members are what arrive over IPC, so a
    // missing member is a value the webview's type says cannot exist.
    const checked: string[] = [];
    for (const declaration of mirror) {
      const counterpart = host.get(declaration.name);
      if (counterpart === undefined) continue;
      const mine = unionMembers(declaration.body);
      const theirs = unionMembers(counterpart.body);
      if (mine === null || theirs === null) continue;
      const missing = [...theirs].filter((member) => !mine.has(member));
      checked.push(declaration.name);
      expect(
        missing,
        `${MIRROR}'s ${declaration.name} omits string member(s) the host declares in ` +
          `${counterpart.file}. The host can send them; this type says they cannot exist. This is ` +
          "exactly how QueueSummary.pauseSource lost 'retry-cap' — found by measuring, not by a " +
          'gate. Import the host type, or add the member.'
      ).toEqual([]);
    }
    expect(checked.length, 'no shared unions were compared — the check is vacuous').toBeGreaterThan(
      2
    );
  });
});
