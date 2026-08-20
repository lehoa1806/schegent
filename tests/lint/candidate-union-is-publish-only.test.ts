// Feature 100 (FR-R3-016) T500c — the candidate union belongs to the publish
// gate and to nothing else.
//
// FR-017 lets a publication validate against the *union* of the active catalog
// and the bodies it is about to make live, which is what allows a Phase and the
// Pipeline that binds it to go live in one operation. FR-018 bounds that: the
// union is a projection of one pending write, alive for one validation and
// persisted nowhere.
//
// T514a covers the positive — the carve-out admits a self-contained set. This is
// the negative it cannot cover, and the negative is the dangerous half. If the
// union leaked to a second consumer, the leak would not look like a bug:
//
//   - The **effective catalog** would gain a definition no publication had made
//     live, so an unpublished body would become triggerable (FR-007, FR-041).
//   - The **deactivation gate** would find a blocker in a body that is not stored,
//     refusing an operator's deactivation because of a write that never landed
//     (FR-025).
//   - The **import planner** would resolve presence against the union rather than
//     against stored definitions, which FR-043 forbids in those words.
//
// So the property is asserted two ways. Statically: `defectsOf` is reached from
// exactly two modules, and the candidate type is named in exactly the four that
// declare, re-export, implement, and construct it. Structurally and behaviourally:
// the interface gives the other two semantics methods no way to receive a
// candidate, and a validation call leaves the snapshot it validated against
// byte-identical — the union exists inside `defectsOf` and nowhere the caller can
// observe it.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { storedRows } from '../../src/catalog';
import type { CandidateDefinition } from '../../src/catalog';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import { phaseBody, pipelineBody } from '../fixtures/catalog-lifecycle-harness';
import { snapshotOf } from '../fixtures/catalog-snapshot-fixture';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [resolve(REPO_ROOT, 'src'), resolve(REPO_ROOT, 'webview-ui', 'src')];

/** Where `defectsOf` may be called from: the two halves of the publish gate. */
const PUBLISH_GATE: readonly string[] = [
  'src/catalog/lifecycle-service.ts',
  'src/catalog/package-publish.ts'
];

/**
 * Where the candidate type may be named.
 *
 * Wider than the call sites by design, and every entry earns its place:
 * `ports.ts` declares it, `index.ts` re-exports it as part of the store's public
 * surface, `definition-semantics.ts` implements the method that takes it, and
 * `package-publish.ts` builds the list. `lifecycle-service.ts` is absent because
 * it passes an inline array literal and never names the type — which is why the
 * `.defectsOf(` scan below is the load-bearing one and this list is its
 * complement.
 */
const CANDIDATE_TYPE_SITES: readonly string[] = [
  'src/catalog/index.ts',
  'src/catalog/package-publish.ts',
  'src/catalog/ports.ts',
  'src/config/definition-semantics.ts'
];

const PORTS_MODULE = 'src/catalog/ports.ts';

function relativize(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listFiles(): readonly string[] {
  const roots = SCAN_ROOTS.map((root) => `"${root}"`).join(' ');
  const out = execSync(`find ${roots} \\( -name '*.svelte' -o -name '*.ts' \\)`, {
    encoding: 'utf8'
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const SOURCES: ReadonlyMap<string, string> = new Map(
  listFiles().map((abs) => [relativize(abs), readFileSync(abs, 'utf8')])
);

/** Files matching `re`, by repo-relative path. */
function filesMatching(re: RegExp): readonly string[] {
  return [...SOURCES.entries()]
    .filter(([, source]) => re.test(source))
    .map(([rel]) => rel)
    .sort();
}

describe('Feature 100 T500c — only the publish gate builds a candidate union', () => {
  it('finds the modules on disk (sanity — an empty scan must not pass)', () => {
    const scanned = [...SOURCES.keys()];
    for (const module of [...PUBLISH_GATE, ...CANDIDATE_TYPE_SITES]) {
      expect(scanned, `${module} must be in the scan`).toContain(module);
    }
  });

  it('calls defectsOf from the publish gate and from nowhere else', () => {
    // Anchored on the dot so the implementation module's own recursive call and
    // the interface's declaration are not counted as consumers: this rule is
    // about who *asks* for a union, not about who spells the word.
    const callers = filesMatching(/\.defectsOf\s*\(/);
    expect(callers).toEqual([...PUBLISH_GATE].sort());
  });

  it('names the candidate type only where it is declared, exported, implemented, and built', () => {
    expect(filesMatching(/\bCandidateDefinition\b/)).toEqual([...CANDIDATE_TYPE_SITES].sort());
  });

  it('gives the other semantics methods no parameter that could carry a candidate', () => {
    // The type-level half of the rule, and the one that survives a refactor: a
    // consumer cannot pass an augmented catalog to `referencesTo` or
    // `advisoriesFor` because neither accepts one. Counted rather than eyeballed
    // so a second candidate-taking method cannot be added quietly.
    const ports = SOURCES.get(PORTS_MODULE) ?? '';
    const parameters = ports.match(/readonly CandidateDefinition\[\]/g) ?? [];
    expect(parameters).toHaveLength(1);
  });

  it('no webview module mentions the candidate union at all', () => {
    // The union is a host-side projection over stored bodies. A webview that knew
    // about it would be a webview deciding what is live.
    const offenders = filesMatching(/\b(CandidateDefinition|defectsOf)\b/).filter((rel) =>
      rel.startsWith('webview-ui/')
    );
    expect(offenders, `Webview modules referencing the union:\n${offenders.join('\n')}`).toEqual(
      []
    );
  });
});

describe('Feature 100 T500c — the union is persisted nowhere (FR-018)', () => {
  const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

  const ACTIVE_PHASE = 'specify';
  const CANDIDATE_PHASE = 'plan';
  const CANDIDATE_PIPELINE = 'ship-it';

  /** One Phase live, and nothing else. */
  const activeSnapshot = () => snapshotOf({ phases: [phaseBody(ACTIVE_PHASE)] });

  /**
   * A self-contained set: a new Phase and a Pipeline that binds it alongside the
   * one already live. This is the FR-017 carve-out — the set validates only
   * because the union resolves the Phase the Pipeline names.
   */
  const candidates: readonly CandidateDefinition[] = [
    { kind: 'phase', id: CANDIDATE_PHASE, body: phaseBody(CANDIDATE_PHASE) },
    {
      kind: 'pipeline',
      id: CANDIDATE_PIPELINE,
      body: pipelineBody(CANDIDATE_PIPELINE, [ACTIVE_PHASE, CANDIDATE_PHASE], {
        inputs: [],
        outputs: []
      })
    }
  ];

  it('validates the self-contained set (positive control)', () => {
    // Without this the assertions below would hold for a set that never resolved,
    // and "the union did not leak" would be indistinguishable from "there was no
    // union".
    expect(semantics.defectsOf(activeSnapshot(), candidates)).toEqual([]);
  });

  it('leaves the snapshot it validated against byte-identical', () => {
    const snapshot = activeSnapshot();
    const before = structuredClone(snapshot);

    semantics.defectsOf(snapshot, candidates);

    expect(snapshot).toEqual(before);
  });

  it('adds nothing to the effective catalog', () => {
    const snapshot = activeSnapshot();
    semantics.defectsOf(snapshot, candidates);

    // The Pipeline validated a moment ago is not triggerable, and will not be
    // until a publication moves its active pointer (FR-007, FR-041).
    expect(storedRows(snapshot, 'phase')).toEqual([phaseBody(ACTIVE_PHASE)]);
    expect(storedRows(snapshot, 'pipeline')).toEqual([]);
  });

  it('gives the deactivation gate no blocker from a candidate', () => {
    const snapshot = activeSnapshot();
    semantics.defectsOf(snapshot, candidates);

    // Inside the validation, the candidate Pipeline resolved and bound both
    // Phases. Outside it, that Pipeline does not exist — so taking the live Phase
    // out of service is unblocked, which is the whole difference between a
    // pending write and a stored one (FR-025).
    expect(semantics.referencesTo(snapshot, 'phase', ACTIVE_PHASE)).toEqual([]);
    expect(semantics.referencesTo(snapshot, 'phase', CANDIDATE_PHASE)).toEqual([]);
    expect(semantics.advisoriesFor(snapshot, 'phase', ACTIVE_PHASE)).toEqual([]);
  });

  it('holds no union at all when the candidate list is empty', () => {
    // Every consumer other than the publish gate is this call: no candidates, so
    // the active catalog unaugmented. Stated as a claim rather than left implicit
    // in the early return.
    const snapshot = activeSnapshot();
    expect(semantics.defectsOf(snapshot, [])).toEqual([]);
    expect(storedRows(snapshot, 'pipeline')).toEqual([]);
  });
});
