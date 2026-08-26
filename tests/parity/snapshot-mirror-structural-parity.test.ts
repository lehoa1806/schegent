import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, buildIdleSnapshot } from '../../src/ui/sidebar/snapshot';

/**
 * FR-R3-110 (FR-102) — the hand-maintained mirror is checked on SHAPE, not only on a version
 * number.
 *
 * WHAT THE MIRROR IS. `webview-ui/src/lib/snapshot-types.ts` is **1,455 hand-written lines**
 * mirroring the host's snapshot types. It exists because the webview must not import host code
 * (`FR-R3-110` FR-099), and it drifts because nothing structural compares the two.
 *
 * WHY THE EXISTING GUARD IS NOT ENOUGH. `visual-fixture-schema-parity.test.ts` compares a scalar
 * `SCHEMA_VERSION` and scrapes the store's accept gate with a regex. Both are worth having and
 * neither can see a field added to the host and forgotten in the mirror while the version stays
 * put — which is precisely what happened: **13 of 16 visual checks failed silently** after a real
 * incident, because the mirror accepted a snapshot whose shape it no longer described.
 *
 * WHY A STRUCTURAL COMPARISON AND NOT GENERATION. Generation is the stronger answer and the
 * source item recommends it. It is deliberately deferred and recorded: emitting 1,455 lines
 * deterministically, diffed in the freshness check like the other generated artifacts, is its own
 * change with its own failure modes, and this batch already carries fifteen other items. What
 * this delivers is the acceptance criterion — *fails on shape divergence, not just version
 * inequality* — at a fraction of the risk. The version comparison stays as the cheap outer guard.
 *
 * HOW IT COMPARES. The host's own `buildIdleSnapshot()` is the reference: it is the shape the
 * projector actually produces, so its top-level keys are the contract the mirror must describe.
 * Comparing a real produced object rather than parsing type declarations means the check cannot
 * be satisfied by a type that no code emits.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const MIRROR = resolve(REPO_ROOT, 'webview-ui/src/lib/snapshot-types.ts');
const mirrorSource = (): string => readFileSync(MIRROR, 'utf8');

const HOST = resolve(REPO_ROOT, 'src/ui/sidebar/snapshot.ts');
const hostSource = (): string => readFileSync(HOST, 'utf8');

/**
 * The field names a `WorkflowSnapshot` interface DECLARES, from either side.
 *
 * Declarations rather than a produced object, for the two-directional comparison.
 * `buildIdleSnapshot()` omits every optional field — `phaseCatalog` and ten others appear only on
 * a populated snapshot — so an idle instance is a subset of the type and comparing the mirror
 * against it would report eleven false divergences. That was this test's first form, and it
 * failed on exactly those eleven.
 */
function declaredFields(source: string, where: string): readonly string[] {
  const start = source.indexOf('export interface WorkflowSnapshot');
  expect(start, `${where} must declare WorkflowSnapshot`).toBeGreaterThanOrEqual(0);
  // The interface body: up to the first line that closes a block at column 0.
  const body = source.slice(start).split(/\n\}/)[0] as string;
  return [...body.matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(
    (m) => m[1] as string
  );
}

const hostSnapshotFields = (): readonly string[] => declaredFields(hostSource(), 'the host');
const mirrorSnapshotFields = (): readonly string[] => declaredFields(mirrorSource(), 'the mirror');

/**
 * What the host actually PRODUCES on an idle snapshot.
 *
 * A third, independent check: a field the projector emits but no interface declares would pass
 * both declaration comparisons above and still reach the webview as an undeclared key.
 */
function producedKeys(): readonly string[] {
  return Object.keys(buildIdleSnapshot({ isPrimary: true, producedAt: new Date().toISOString() }));
}

describe('FR-R3-110 — the snapshot mirror matches the host on SHAPE', () => {
  it('the mirror is non-trivial, so a truncated file cannot read as agreement', () => {
    // The floor. A mirror reduced to a stub would satisfy a subset check trivially.
    expect(mirrorSource().split('\n').length).toBeGreaterThan(500);
    expect(mirrorSnapshotFields().length).toBeGreaterThan(10);
    expect(hostSnapshotFields().length).toBeGreaterThan(10);
  });

  it('every field the host DECLARES is declared by the mirror', () => {
    // The direction that caused the incident: a field added host-side and forgotten in the
    // mirror. The webview then reads `undefined` from a snapshot that passed the version gate.
    const missing = hostSnapshotFields().filter((field) => !mirrorSnapshotFields().includes(field));
    expect(
      missing,
      'The host produces snapshot fields the webview mirror does not declare. The version gate ' +
        'cannot see this: a snapshot with the right schemaVersion and an undeclared field is ' +
        'accepted, and the webview reads undefined. This is the shape that failed 13 of 16 ' +
        'visual checks silently. Add the field to webview-ui/src/lib/snapshot-types.ts.'
    ).toEqual([]);
  });

  it('the mirror declares no top-level field the host does not produce', () => {
    // The other direction is a weaker failure but still a lie: a mirror field nothing populates
    // is a shape the webview may branch on and never see.
    const extra = mirrorSnapshotFields().filter((field) => !hostSnapshotFields().includes(field));
    expect(
      extra,
      'The webview mirror declares top-level snapshot fields the host never produces. Either the ' +
        'host stopped emitting them (remove them from the mirror) or they were never emitted.'
    ).toEqual([]);
  });

  it('every field the host PRODUCES is declared on both sides', () => {
    // Independent of the two declaration comparisons: a key the projector emits that neither
    // interface declares would satisfy both and still arrive at the webview undeclared.
    const produced = producedKeys();
    expect(produced.length).toBeGreaterThan(5);
    expect(produced.filter((key) => !hostSnapshotFields().includes(key))).toEqual([]);
    expect(produced.filter((key) => !mirrorSnapshotFields().includes(key))).toEqual([]);
  });

  it('the version comparison is still present, as the cheap outer guard', async () => {
    // Not replaced. It catches a deliberate schema bump where the shape check would pass because
    // both sides changed — and it costs nothing.
    const mirror = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(mirror.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it('NON-VACUITY: a field removed from the mirror is detected', () => {
    // The mutation runs against the real extraction over the real source, in memory. A
    // hand-written stub would only prove the regex matches a string written to be matched.
    const hostKeys = hostSnapshotFields();
    const victim = hostKeys[0] as string;
    const mutated = mirrorSource().replace(
      new RegExp(`^(\\s*)readonly ${victim}(\\??:)`, 'm'),
      '$1readonly __removed__$2'
    );
    expect(mutated, 'the mutation must change something').not.toBe(mirrorSource());

    const fields = declaredFields(mutated, 'the mutated mirror');
    expect(
      hostKeys.filter((key) => !fields.includes(key)),
      'removing a host-produced field from the mirror must be detected'
    ).toEqual([victim]);
  });

  it('records that GENERATION is the stronger deferred option', () => {
    // Kept as an assertion rather than only a comment so the deferral is visible in the same
    // place as the check that stands in for it.
    const source = readFileSync(__filename, 'utf8');
    expect(source).toContain('Generation is the stronger answer');
  });
});
