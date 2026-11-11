// FR-R6-F15 T024 — acceptance: each row of the Acceptance table, US2 scenarios 1 to 7, 100
// duplicate acceptances (NFR-004), edits as new revisions, approvals bound to one revision,
// dispatch intents, and a store that throws or loses a version race.
import { describe, expect, it } from 'vitest';

import type {
  AcceptedRevision,
  HandoffRecord,
  HandoffStorePort,
  ManifestSource,
  PreparedHandoff
} from '../../../src/contracts/phase-context/context-manifest';
import { PHASE_CONTEXT_LIMITS } from '../../../src/contracts/phase-context/context-policy';
import { createAcceptanceService, type AcceptanceService } from '../../../src/services/phase-context/acceptance';
import {
  buildManifest,
  manifestDigestOf,
  parseManifest,
  serializeManifest,
  type ManifestInput
} from '../../../src/services/phase-context/manifest';
import { createMemoryHandoffStore } from '../../../src/services/phase-context/memory-store';
import { renderContext } from '../../../src/services/phase-context/renderer';
import { digestOf, manifestInput, manifestSource, omission } from '../../fixtures/phase-context/builders';

const TARGET = 'att-implement-1';
const REPRESENTATION = digestOf('d');

function preparedOf(input: ManifestInput): PreparedHandoff {
  const manifest = buildManifest(input);
  const serialized = serializeManifest(manifest);
  return { manifest, serialized, manifestDigest: manifestDigestOf(serialized), rendered: renderContext(manifest) };
}

/** Revision 1 of the default handoff, or the revision the overrides name. */
function prepared(overrides: Partial<ManifestInput> = {}, sources: readonly ManifestSource[] = [manifestSource()]): PreparedHandoff {
  return preparedOf(manifestInput(sources, overrides));
}

function later(revision: number, overrides: Partial<ManifestInput> = {}): PreparedHandoff {
  return prepared({ revision, previousRevision: revision - 1, ...overrides });
}

const HANDOFF_ID = prepared().manifest.handoffId;

function setup(store: HandoffStorePort = createMemoryHandoffStore()): { store: HandoffStorePort; service: AcceptanceService } {
  return { store, service: createAcceptanceService(store) };
}

function passed<T extends { readonly ok: boolean }>(result: T): Extract<T, { readonly ok: true }> {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { readonly ok: true }>;
}

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function recordOf(service: AcceptanceService, handoffId = HANDOFF_ID): HandoffRecord {
  const { record } = passed(service.inspect(handoffId));
  if (record === null) throw new Error('expected a record');
  return record;
}

function statesOf(service: AcceptanceService): string[] {
  return recordOf(service).revisions.map((entry) => `${entry.revision}:${entry.state}`);
}

/** A store that counts its calls and can lose the next saves or throw. */
function watchedStore(options: { loseSaves?: number; throwOn?: 'load' | 'save'; onLostSave?: () => void } = {}) {
  const inner = createMemoryHandoffStore();
  const calls = { loads: 0, saves: 0 };
  let losses = options.loseSaves ?? 0;
  const store: HandoffStorePort = {
    load(handoffId) {
      calls.loads += 1;
      if (options.throwOn === 'load') throw new Error('store down');
      return inner.load(handoffId);
    },
    save(record, expectedVersion) {
      calls.saves += 1;
      if (options.throwOn === 'save') throw new Error('store down');
      if (losses > 0) {
        losses -= 1;
        options.onLostSave?.();
        return false;
      }
      return inner.save(record, expectedVersion);
    }
  };
  return { store, inner, calls };
}

describe('accepting a prepared handoff', () => {
  it('records revision 1 of an automatic handoff as ready, with no approval (US2 scenario 6)', () => {
    const { service } = setup();
    const handoff = prepared();

    const result = passed(service.accept(handoff));

    const expected: AcceptedRevision = {
      revision: 1,
      manifestDigest: handoff.manifestDigest,
      serializedManifest: handoff.serialized,
      rendererVersion: 1,
      renderedDigest: handoff.rendered.digestHex,
      renderedBytes: handoff.rendered.bytes,
      state: 'ready'
    };
    expect(result).toEqual({ ok: true, revision: expected, created: true });
    expect(recordOf(service)).toEqual({ handoffId: HANDOFF_ID, version: 1, revisions: [expected], approvals: [], dispatches: [] });
  });

  it('records revision 1 of a manual handoff as waiting for approval', () => {
    const { service } = setup();

    expect(passed(service.accept(prepared({ approval: 'manual' }))).revision.state).toBe('waiting-approval');
    expect(recordOf(service).approvals).toEqual([]);
  });

  it('returns the stored revision when the same revision is accepted again, and writes nothing', () => {
    const watched = watchedStore();
    const { service } = setup(watched.store);
    const first = passed(service.accept(prepared()));

    const again = passed(service.accept(prepared()));

    expect(again).toEqual({ ok: true, revision: first.revision, created: false });
    expect(watched.calls.saves).toBe(1);
    expect(recordOf(service).version).toBe(1);
  });

  it('leaves one accepted revision after 100 requests, and every request returns it (NFR-004, US2 scenario 1)', () => {
    const { service } = setup();

    const results = Array.from({ length: 100 }, () => passed(service.accept(prepared())));

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.at(0)?.created).toBe(true);
    expect(new Set(results.map((result) => JSON.stringify(result.revision))).size).toBe(1);
    expect(recordOf(service).revisions).toHaveLength(1);
    expect(recordOf(service).version).toBe(1);
  });

  it('refuses the same revision number with other content as stale (US2 scenario 2)', () => {
    const { service } = setup();
    service.accept(prepared());
    const before = recordOf(service);

    expect(service.accept(prepared({ cutoffSequence: 11 }))).toEqual(refusal('stale-revision', 'revision-conflict'));
    expect(recordOf(service)).toEqual(before);
  });

  it('accepts the next revision and marks the earlier one superseded, its manifest unchanged', () => {
    const { service } = setup();
    const first = passed(service.accept(prepared()));

    const second = passed(service.accept(later(2, { cutoffSequence: 12 })));

    expect(second.created).toBe(true);
    expect(second.revision.state).toBe('ready');
    expect(recordOf(service).revisions).toEqual([{ ...first.revision, state: 'superseded' }, second.revision]);
    expect(recordOf(service).version).toBe(2);
  });

  it('returns a superseded revision accepted again as it is stored', () => {
    const { service } = setup();
    service.accept(prepared());
    service.accept(later(2));

    const again = passed(service.accept(prepared()));

    expect(again.created).toBe(false);
    expect(again.revision.state).toBe('superseded');
    expect(statesOf(service)).toEqual(['1:superseded', '2:ready']);
  });

  it.each([
    ['revision 2 of a handoff with no record', 0, 2],
    ['revision 3 while revision 1 is current', 1, 3],
    ['revision 4 while revision 2 is current', 2, 4]
  ])('refuses %s as stale', (_label, acceptedSoFar, revision) => {
    const { service } = setup();
    for (let number = 1; number <= acceptedSoFar; number += 1) passed(service.accept(number === 1 ? prepared() : later(number)));

    expect(service.accept(later(revision))).toEqual(refusal('stale-revision', 'revision-number'));
    expect(passed(service.inspect(HANDOFF_ID)).record?.revisions.length ?? 0).toBe(acceptedSoFar);
  });

  it.each([
    ['another policy digest', { policyDigest: digestOf('9') }],
    ['automatic approval after manual', { approval: 'automatic' as const }],
    ['another session policy', { session: 'reuse-when-qualified' as const }],
    ['other target instructions', { targetInstructionsDigest: digestOf('8') }]
  ])('refuses a next revision with %s as stale', (_label, change) => {
    const { service } = setup();
    service.accept(prepared({ approval: 'manual' }));

    expect(service.accept(later(2, { approval: 'manual', ...change }))).toEqual(refusal('stale-revision', 'revision-basis'));
    expect(statesOf(service)).toEqual(['1:waiting-approval']);
  });

  it('holds 16 revisions and refuses a seventeenth', () => {
    const { service } = setup();
    passed(service.accept(prepared()));
    for (let number = 2; number <= PHASE_CONTEXT_LIMITS.revisionsMax; number += 1) passed(service.accept(later(number)));

    expect(service.accept(later(17))).toEqual(refusal('capacity-exceeded', 'revision-count'));
    expect(recordOf(service).revisions).toHaveLength(16);
    expect(recordOf(service).revisions.at(-1)?.state).toBe('ready');
  });

  it('keeps handoffs of different identities apart', () => {
    const { service } = setup();
    const other = prepared({}, [manifestSource('research')]);

    passed(service.accept(prepared()));
    passed(service.accept(other));

    expect(other.manifest.handoffId).not.toBe(HANDOFF_ID);
    expect(recordOf(service).revisions).toHaveLength(1);
    expect(recordOf(service, other.manifest.handoffId).revisions).toHaveLength(1);
  });
});

describe('a prepared handoff that is not what it says', () => {
  const good = prepared();
  const newer = JSON.stringify({ ...JSON.parse(good.serialized), manifestVersion: 2 });
  const wrongOrigin = JSON.stringify({ ...JSON.parse(good.serialized), origin: 'imported' });
  const tight = prepared({ renderedBytesMax: 8 });

  it.each([
    ['a value that is not a record', null as unknown as PreparedHandoff, 'invalid-source', 'prepared-shape'],
    ['serialized text that is not text', { ...good, serialized: 7 as unknown as string }, 'invalid-source', 'prepared-shape'],
    ['serialized text that is not JSON', { ...good, serialized: '{"manifestVersion":1' }, 'invalid-source', 'prepared-manifest'],
    ['a manifest of a newer version', { ...good, serialized: newer, manifestDigest: manifestDigestOf(newer) }, 'unsupported-version', 'manifest-version'],
    ['a manifest the parser refuses', { ...good, serialized: wrongOrigin, manifestDigest: manifestDigestOf(wrongOrigin) }, 'invalid-source', 'origin'],
    ['text that is not the one serialization', { ...good, serialized: ` ${good.serialized}` }, 'invalid-source', 'prepared-not-canonical'],
    ['a digest of other text', { ...good, manifestDigest: digestOf('0') }, 'invalid-source', 'prepared-digest'],
    ['rendered text of another manifest', { ...good, rendered: { ...good.rendered, text: `${good.rendered.text}more` } }, 'invalid-source', 'prepared-rendered'],
    ['a rendered digest of other text', { ...good, rendered: { ...good.rendered, digestHex: digestOf('0') } }, 'invalid-source', 'prepared-rendered'],
    ['a rendered size of other text', { ...good, rendered: { ...good.rendered, bytes: 1 } }, 'invalid-source', 'prepared-rendered'],
    ['a rendered context of another renderer version', { ...good, rendered: { ...good.rendered, rendererVersion: 2 } } as unknown as PreparedHandoff, 'invalid-source', 'prepared-rendered'],
    ['a rendered context over the bound its manifest records', tight, 'capacity-exceeded', 'rendered-bytes'],
    ['serialized text over the manifest limit', { ...good, serialized: 'a'.repeat(PHASE_CONTEXT_LIMITS.manifestBytesMax + 1) }, 'capacity-exceeded', 'manifest-bytes']
  ])('refuses %s and stores nothing', (_label, handoff, failure, detail) => {
    const watched = watchedStore();
    const { service } = setup(watched.store);

    expect(service.accept(handoff)).toEqual(refusal(failure, detail));
    expect(watched.calls.saves).toBe(0);
    expect(passed(service.inspect(HANDOFF_ID)).record).toBeNull();
  });

  it('takes the revision from the serialized text, not from the manifest object beside it', () => {
    const { service } = setup();
    const lying = { ...good, manifest: later(2).manifest };

    expect(passed(service.accept(lying)).revision.revision).toBe(1);
  });
});

describe('editing a revision', () => {
  const plan = manifestSource('plan');
  const research = manifestSource('research', { required: false });
  const base = prepared({ omissions: [omission('notes')], omissionsUnlisted: 3 }, [plan, research]);
  const baseId = base.manifest.handoffId;
  const editedPlan = { ...plan, outcomes: ['The plan lists three steps.'] };

  it('records the next revision as edited and keeps the basis of its base (US2 scenario 3)', () => {
    const { service } = setup();
    const first = passed(service.accept(base));

    const result = passed(service.edit(baseId, 1, [editedPlan]));

    const { manifest } = result.prepared;
    expect(manifest.revision).toBe(2);
    expect(manifest.previousRevision).toBe(1);
    expect(manifest.origin).toBe('edited');
    expect(manifest.sources).toEqual([editedPlan]);
    expect(manifest.handoffId).toBe(baseId);
    expect(manifest.identity).toEqual(base.manifest.identity);
    expect(manifest.policyDigest).toBe(base.manifest.policyDigest);
    expect(manifest.cutoffSequence).toBe(base.manifest.cutoffSequence);
    expect(manifest.targetInstructionsDigest).toBe(base.manifest.targetInstructionsDigest);
    expect(manifest.approval).toBe(base.manifest.approval);
    expect(manifest.session).toBe(base.manifest.session);
    expect(manifest.renderedBytesMax).toBe(base.manifest.renderedBytesMax);
    expect(manifest.omissions).toEqual(base.manifest.omissions);
    expect(manifest.omissionsUnlisted).toBe(3);
    expect(recordOf(service, baseId).revisions).toEqual([{ ...first.revision, state: 'superseded' }, result.revision]);
    expect(recordOf(service, baseId).revisions.at(0)?.serializedManifest).toBe(base.serialized);
  });

  it('returns a prepared handoff that is the stored revision and can be accepted again', () => {
    const { service } = setup();
    service.accept(base);

    const result = passed(service.edit(baseId, 1, [editedPlan, research]));

    expect(result.revision.serializedManifest).toBe(result.prepared.serialized);
    expect(result.revision.manifestDigest).toBe(manifestDigestOf(result.prepared.serialized));
    expect(result.revision.renderedDigest).toBe(result.prepared.rendered.digestHex);
    expect(result.prepared.rendered).toEqual(renderContext(result.prepared.manifest));
    expect(parseManifest(JSON.parse(result.prepared.serialized))).toEqual({ kind: 'valid', manifest: result.prepared.manifest });
    expect(passed(service.accept(result.prepared))).toEqual({ ok: true, revision: result.revision, created: false });
  });

  it('makes an edited revision of a manual handoff wait, whatever was approved before', () => {
    const { service } = setup();
    const manual = prepared({ approval: 'manual' }, [plan, research]);
    service.accept(manual);
    passed(service.approve(baseId, 1, 'decision-1'));

    const result = passed(service.edit(baseId, 1, [plan]));

    expect(result.revision.state).toBe('waiting-approval');
    expect(recordOf(service, baseId).approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
    expect(service.recordDispatchIntent(baseId, 2, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', 'revision-not-ready'));
    expect(service.recordDispatchIntent(baseId, 1, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', 'revision-not-ready'));
  });

  it.each([
    ['a handoff with no record', digestOf('7'), 1, 'unknown-handoff'],
    ['a revision that was superseded', null, 1, 'revision-not-current'],
    ['a revision that does not exist yet', null, 3, 'revision-not-current']
  ])('refuses an edit of %s as stale', (_label, handoffId, baseRevision, detail) => {
    const { service } = setup();
    service.accept(base);
    passed(service.edit(baseId, 1, [plan]));
    const before = recordOf(service, baseId);

    expect(service.edit(handoffId ?? baseId, baseRevision, [plan])).toEqual(refusal('stale-revision', detail));
    expect(recordOf(service, baseId)).toEqual(before);
  });

  it('stores nothing when the replacement sources are refused', () => {
    const watched = watchedStore();
    const { service } = setup(watched.store);
    service.accept(base);

    expect(service.edit(baseId, 1, [research])).toEqual(refusal('invalid-source', 'edit-required-removed'));
    expect(service.edit(baseId, 1, 'plan')).toEqual(refusal('invalid-source', 'sources'));
    expect(watched.calls.saves).toBe(1);
    expect(recordOf(service, baseId).revisions).toHaveLength(1);
  });

  it('refuses the edit that would make a seventeenth revision', () => {
    const { service } = setup();
    service.accept(base);
    for (let number = 1; number < PHASE_CONTEXT_LIMITS.revisionsMax; number += 1) passed(service.edit(baseId, number, [plan]));

    expect(service.edit(baseId, 16, [plan])).toEqual(refusal('capacity-exceeded', 'revision-count'));
    expect(recordOf(service, baseId).revisions).toHaveLength(16);
  });

  it('refuses an edit whose stored base cannot be read', () => {
    const store = createMemoryHandoffStore();
    store.save(
      { handoffId: baseId, version: 0, revisions: [{ ...passed(setup().service.accept(base)).revision, serializedManifest: '{' }], approvals: [], dispatches: [] },
      0
    );

    expect(setup(store).service.edit(baseId, 1, [plan])).toEqual(refusal('storage-unavailable', 'stored-manifest'));
  });

  it('refuses an edit whose stored base is not the text its digest was taken of', () => {
    const store = createMemoryHandoffStore();
    const other = prepared({ omissions: [omission('notes')], omissionsUnlisted: 3 }, [{ ...plan, outcomes: ['Another outcome.'] }, research]);
    store.save(
      {
        handoffId: baseId,
        version: 0,
        revisions: [{ ...passed(setup().service.accept(base)).revision, serializedManifest: other.serialized }],
        approvals: [],
        dispatches: []
      },
      0
    );

    expect(other.manifest.handoffId).toBe(baseId);
    expect(setup(store).service.edit(baseId, 1, [plan])).toEqual(refusal('storage-unavailable', 'stored-manifest'));
    const successor = prepared({ omissions: [omission('notes')], omissionsUnlisted: 3, revision: 2, previousRevision: 1 }, [plan, research]);
    expect(successor.manifest.handoffId).toBe(baseId);
    expect(setup(store).service.accept(successor)).toEqual(refusal('storage-unavailable', 'stored-manifest'));
  });
});

describe('approving a revision', () => {
  function manualSetup() {
    const context = setup();
    passed(context.service.accept(prepared({ approval: 'manual' })));
    return context;
  }

  it('records the decision and makes the revision ready', () => {
    const { service } = manualSetup();

    const result = passed(service.approve(HANDOFF_ID, 1, 'decision-1'));

    expect(result).toEqual({ ok: true, approval: { revision: 1, decisionId: 'decision-1' }, created: true });
    expect(statesOf(service)).toEqual(['1:ready']);
    expect(recordOf(service).approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
  });

  it('returns the stored approval when the same decision comes again, and writes nothing', () => {
    const watched = watchedStore();
    const { service } = setup(watched.store);
    service.accept(prepared({ approval: 'manual' }));
    service.approve(HANDOFF_ID, 1, 'decision-1');

    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual({ ok: true, approval: { revision: 1, decisionId: 'decision-1' }, created: false });
    expect(watched.calls.saves).toBe(2);
    expect(recordOf(service).approvals).toHaveLength(1);
  });

  it('refuses another decision for an approved revision as stale', () => {
    const { service } = manualSetup();
    service.approve(HANDOFF_ID, 1, 'decision-1');

    expect(service.approve(HANDOFF_ID, 1, 'decision-2')).toEqual(refusal('stale-revision', 'approval-conflict'));
    expect(recordOf(service).approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
  });

  it('refuses an approval of an automatic handoff', () => {
    const { service } = setup();
    service.accept(prepared());

    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual(refusal('invalid-policy', 'approval-not-required'));
    expect(recordOf(service).approvals).toEqual([]);
  });

  it('refuses an approval of revision 1 while revision 2 is current, and revision 2 stays unapproved (US2 scenario 5)', () => {
    const { service } = manualSetup();
    passed(service.accept(later(2, { approval: 'manual' })));

    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual(refusal('stale-revision', 'revision-not-current'));
    expect(statesOf(service)).toEqual(['1:superseded', '2:waiting-approval']);
    expect(recordOf(service).approvals).toEqual([]);
  });

  it('does not carry the approval of revision 1 to revision 2', () => {
    const { service } = manualSetup();
    service.approve(HANDOFF_ID, 1, 'decision-1');
    passed(service.accept(later(2, { approval: 'manual' })));

    expect(statesOf(service)).toEqual(['1:superseded', '2:waiting-approval']);
    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual(refusal('stale-revision', 'revision-not-current'));
    expect(passed(service.approve(HANDOFF_ID, 2, 'decision-2')).created).toBe(true);
    expect(recordOf(service).approvals).toEqual([
      { revision: 1, decisionId: 'decision-1' },
      { revision: 2, decisionId: 'decision-2' }
    ]);
  });

  it.each([
    ['a handoff with no record', digestOf('7'), 1, 'unknown-handoff'],
    ['a revision the handoff does not hold', null, 2, 'unknown-revision']
  ])('refuses an approval of %s as stale', (_label, handoffId, revision, detail) => {
    const { service } = manualSetup();

    expect(service.approve(handoffId ?? HANDOFF_ID, revision, 'decision-1')).toEqual(refusal('stale-revision', detail));
    expect(statesOf(service)).toEqual(['1:waiting-approval']);
  });
});

describe('inspecting a handoff', () => {
  it('reports no record for a handoff nothing accepted', () => {
    expect(setup().service.inspect(HANDOFF_ID)).toEqual({ ok: true, record: null });
  });

  it('writes nothing and approves nothing, in this service or a second one over the same store (US2 scenario 4)', () => {
    const watched = watchedStore();
    const { service } = setup(watched.store);
    service.accept(prepared({ approval: 'manual' }));

    for (let count = 0; count < 5; count += 1) service.inspect(HANDOFF_ID);
    const restarted = setup(watched.store).service;

    expect(watched.calls.saves).toBe(1);
    expect(statesOf(service)).toEqual(['1:waiting-approval']);
    expect(recordOf(restarted)).toEqual(recordOf(service));
    expect(recordOf(restarted).approvals).toEqual([]);
    expect(restarted.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', 'revision-not-ready'));
  });

  it('lets a second service continue what the first one stored', () => {
    const store = createMemoryHandoffStore();
    setup(store).service.accept(prepared({ approval: 'manual' }));

    expect(passed(setup(store).service.approve(HANDOFF_ID, 1, 'decision-1')).created).toBe(true);
    expect(statesOf(setup(store).service)).toEqual(['1:ready']);
  });
});

describe('dispatch intents', () => {
  function readySetup() {
    const context = setup();
    passed(context.service.accept(prepared()));
    return context;
  }

  it('records an intent for a ready revision', () => {
    const { service } = readySetup();
    const intent = { revision: 1, targetAttemptId: TARGET, representationDigest: REPRESENTATION, state: 'intent' };

    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual({ ok: true, dispatch: intent, created: true });
    expect(recordOf(service).dispatches).toEqual([intent]);
  });

  it('returns the stored intent for the same attempt and digest, and writes nothing', () => {
    const watched = watchedStore();
    const { service } = setup(watched.store);
    service.accept(prepared());
    const first = passed(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION));

    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual({ ok: true, dispatch: first.dispatch, created: false });
    expect(watched.calls.saves).toBe(2);
    expect(recordOf(service).dispatches).toHaveLength(1);
  });

  it('refuses the same attempt with another digest as stale', () => {
    const { service } = readySetup();
    service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION);

    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, digestOf('e'))).toEqual(refusal('stale-revision', 'dispatch-conflict'));
    expect(recordOf(service).dispatches).toHaveLength(1);
  });

  it('records one intent per target attempt', () => {
    const { service } = readySetup();

    passed(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION));
    passed(service.recordDispatchIntent(HANDOFF_ID, 1, 'att-implement-2', REPRESENTATION));

    expect(recordOf(service).dispatches.map((entry) => entry.targetAttemptId)).toEqual([TARGET, 'att-implement-2']);
  });

  it.each([
    ['a revision waiting for approval', { approval: 'manual' as const }, 1, 'revision-not-ready'],
    ['a revision the handoff does not hold', {}, 2, 'revision-not-ready']
  ])('refuses an intent for %s as stale', (_label, overrides, revision, detail) => {
    const { service } = setup();
    service.accept(prepared(overrides));

    expect(service.recordDispatchIntent(HANDOFF_ID, revision, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', detail));
    expect(recordOf(service).dispatches).toEqual([]);
  });

  it('refuses an intent for a superseded revision, and for a handoff with no record, as stale', () => {
    const { service } = readySetup();
    service.accept(later(2));

    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', 'revision-not-ready'));
    expect(service.recordDispatchIntent(digestOf('7'), 1, TARGET, REPRESENTATION)).toEqual(refusal('stale-revision', 'unknown-handoff'));
  });

  it('settles an intent as delivered, once', () => {
    const { service } = readySetup();
    service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION);
    const delivered = { revision: 1, targetAttemptId: TARGET, representationDigest: REPRESENTATION, state: 'delivered' };

    expect(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'delivered')).toEqual({ ok: true, dispatch: delivered });
    expect(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'delivered')).toEqual({ ok: true, dispatch: delivered });
    expect(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'uncertain')).toEqual(refusal('stale-revision', 'dispatch-settled'));
    expect(recordOf(service).dispatches).toEqual([delivered]);
    expect(recordOf(service).version).toBe(3);
  });

  it('returns a delivered dispatch to the intent that asks again', () => {
    const { service } = readySetup();
    service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION);
    service.settleDispatch(HANDOFF_ID, 1, TARGET, 'delivered');

    const again = passed(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION));

    expect(again.created).toBe(false);
    expect(again.dispatch.state).toBe('delivered');
  });

  it('refuses a new intent for an attempt whose delivery is uncertain, on any revision', () => {
    const { service } = readySetup();
    service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION);
    passed(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'uncertain'));

    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual(refusal('uncertain-delivery', 'dispatch-uncertain'));
    passed(service.accept(later(2)));
    expect(service.recordDispatchIntent(HANDOFF_ID, 2, TARGET, REPRESENTATION)).toEqual(refusal('uncertain-delivery', 'dispatch-uncertain'));
    expect(passed(service.recordDispatchIntent(HANDOFF_ID, 2, 'att-implement-2', REPRESENTATION)).created).toBe(true);
  });

  it.each([
    ['a handoff with no record', digestOf('7'), 1, TARGET, 'unknown-handoff'],
    ['an attempt with no intent', null, 1, 'att-implement-9', 'unknown-dispatch'],
    ['another revision than the intent names', null, 2, TARGET, 'unknown-dispatch']
  ])('refuses to settle %s as stale', (_label, handoffId, revision, attempt, detail) => {
    const { service } = readySetup();
    service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION);

    expect(service.settleDispatch(handoffId ?? HANDOFF_ID, revision, attempt, 'delivered')).toEqual(refusal('stale-revision', detail));
    expect(recordOf(service).dispatches.at(0)?.state).toBe('intent');
  });

  it('holds 64 dispatch records and refuses the next attempt', () => {
    const { service } = readySetup();
    for (let count = 0; count < PHASE_CONTEXT_LIMITS.dispatchesMax; count += 1) {
      passed(service.recordDispatchIntent(HANDOFF_ID, 1, `att-implement-${count}`, REPRESENTATION));
    }

    expect(PHASE_CONTEXT_LIMITS.dispatchesMax).toBe(64);
    expect(service.recordDispatchIntent(HANDOFF_ID, 1, 'att-implement-64', REPRESENTATION)).toEqual(refusal('capacity-exceeded', 'dispatch-count'));
    expect(passed(service.recordDispatchIntent(HANDOFF_ID, 1, 'att-implement-0', REPRESENTATION)).created).toBe(false);
    expect(recordOf(service).dispatches).toHaveLength(64);
  });
});

describe('values that are not what the service takes', () => {
  it.each([
    ['a handoff identity that is not a digest', (service: AcceptanceService) => service.inspect('handoff-1'), 'handoff-id'],
    ['an edit of such a handoff', (service: AcceptanceService) => service.edit('handoff-1', 1, []), 'handoff-id'],
    ['an edit of revision 0', (service: AcceptanceService) => service.edit(HANDOFF_ID, 0, []), 'revision'],
    ['an approval of revision 1.5', (service: AcceptanceService) => service.approve(HANDOFF_ID, 1.5, 'decision-1'), 'revision'],
    ['an approval with a decision that is not an identifier', (service: AcceptanceService) => service.approve(HANDOFF_ID, 1, 'decision 1'), 'decision-id'],
    ['an intent for an attempt that is not an identifier', (service: AcceptanceService) => service.recordDispatchIntent(HANDOFF_ID, 1, '', REPRESENTATION), 'target-attempt'],
    ['an intent with a digest that is not one', (service: AcceptanceService) => service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, 'abc'), 'representation-digest'],
    ['a settlement of revision 0', (service: AcceptanceService) => service.settleDispatch(HANDOFF_ID, 0, TARGET, 'delivered'), 'revision'],
    [
      'a settlement with an outcome that is not one',
      (service: AcceptanceService) => service.settleDispatch(HANDOFF_ID, 1, TARGET, 'intent' as unknown as 'delivered'),
      'outcome'
    ]
  ])('refuses %s before reading the store', (_label, call, detail) => {
    const watched = watchedStore();
    const { service } = setup(watched.store);

    expect(call(service)).toEqual(refusal('invalid-source', detail));
    expect(watched.calls.loads).toBe(0);
  });
});

/** A list of one entry that was never set. */
function listWithHole(): never[] {
  const list: never[] = [];
  list.length = 1;
  return list;
}

describe('a store that returns a record acceptance did not write', () => {
  function soundRecord(): HandoffRecord {
    const { service } = setup();
    passed(service.accept(prepared()));
    return recordOf(service);
  }

  function storeReturning(record: unknown): { store: HandoffStorePort; saves: () => number } {
    let saves = 0;
    const store: HandoffStorePort = {
      load: () => record as HandoffRecord,
      save: () => {
        saves += 1;
        return true;
      }
    };
    return { store, saves: () => saves };
  }

  it('reads the record it wrote', () => {
    const { store } = storeReturning(soundRecord());

    expect(passed(setup(store).service.inspect(HANDOFF_ID)).record?.revisions).toHaveLength(1);
  });

  it.each<[string, (record: HandoffRecord) => unknown]>([
    ['a revision entry that is null', (record) => ({ ...record, revisions: [null] })],
    ['an approval entry that is null', (record) => ({ ...record, approvals: [null] })],
    ['a dispatch entry that is null', (record) => ({ ...record, dispatches: [null] })],
    ['a revision entry that was never set', (record) => ({ ...record, revisions: listWithHole() })],
    ['an approval entry that was never set', (record) => ({ ...record, approvals: listWithHole() })],
    ['revisions that are not a list', (record) => ({ ...record, revisions: 'none' })],
    ['a revision in a state the contract does not name', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, state: 'draft' })) })],
    ['the record of another handoff', (record) => ({ ...record, handoffId: digestOf('e') })],
    ['a first revision numbered 2', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, revision: 2 })) })],
    ['one revision stored twice', (record) => ({ ...record, revisions: [...record.revisions, ...record.revisions] })],
    ['two revisions stored in reverse order', (record) => ({ ...record, revisions: record.revisions.flatMap((entry) => [{ ...entry, revision: 2 }, entry]) })],
    ['text in place of the record', () => 'record'],
    ['nothing where the port says null', () => undefined]
  ])('refuses every operation on %s, and writes nothing', (_label, alter) => {
    const { store, saves } = storeReturning(alter(soundRecord()));
    const { service } = setup(store);
    const damaged = refusal('storage-unavailable', 'stored-record');

    expect(service.accept(prepared())).toEqual(damaged);
    expect(service.accept(later(2))).toEqual(damaged);
    expect(service.inspect(HANDOFF_ID)).toEqual(damaged);
    expect(service.edit(HANDOFF_ID, 1, [manifestSource()])).toEqual(damaged);
    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual(damaged);
    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual(damaged);
    expect(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'delivered')).toEqual(damaged);
    expect(saves()).toBe(0);
  });
});

describe('a store that fails', () => {
  it.each([
    ['load', 'load' as const],
    ['save', 'save' as const]
  ])('reports storage unavailable when %s throws, and accepts nothing (US2 scenario 7)', (_label, throwOn) => {
    const watched = watchedStore({ throwOn });
    const { service } = setup(watched.store);

    expect(service.accept(prepared())).toEqual(refusal('storage-unavailable', 'store-failure'));
    expect(watched.inner.load(HANDOFF_ID)).toBeNull();
  });

  it('reports storage unavailable for every operation when the store throws', () => {
    const { service } = setup(watchedStore({ throwOn: 'load' }).store);
    const unavailable = refusal('storage-unavailable', 'store-failure');

    expect(service.inspect(HANDOFF_ID)).toEqual(unavailable);
    expect(service.edit(HANDOFF_ID, 1, [])).toEqual(unavailable);
    expect(service.approve(HANDOFF_ID, 1, 'decision-1')).toEqual(unavailable);
    expect(service.recordDispatchIntent(HANDOFF_ID, 1, TARGET, REPRESENTATION)).toEqual(unavailable);
    expect(service.settleDispatch(HANDOFF_ID, 1, TARGET, 'delivered')).toEqual(unavailable);
  });

  it('carries no text of the thrown error in the refusal', () => {
    const { service } = setup(watchedStore({ throwOn: 'save' }).store);

    expect(JSON.stringify(service.accept(prepared()))).not.toContain('store down');
  });

  it('tries once more after a lost version race', () => {
    const watched = watchedStore({ loseSaves: 1 });
    const { service } = setup(watched.store);

    expect(passed(service.accept(prepared())).created).toBe(true);
    expect(watched.calls.saves).toBe(2);
    expect(watched.calls.loads).toBe(2);
  });

  it('reports storage unavailable after two lost races, and accepts nothing', () => {
    const watched = watchedStore({ loseSaves: 2 });
    const { service } = setup(watched.store);

    expect(service.accept(prepared())).toEqual(refusal('storage-unavailable', 'version-race'));
    expect(watched.calls.saves).toBe(2);
    expect(watched.inner.load(HANDOFF_ID)).toBeNull();
  });

  it('returns what another writer stored when that writer won the race with the same revision', () => {
    const rival = { accept: (): void => undefined };
    const watched = watchedStore({ loseSaves: 1, onLostSave: () => rival.accept() });
    rival.accept = () => {
      passed(createAcceptanceService(watched.inner).accept(prepared()));
    };
    const { service } = setup(watched.store);

    const result = passed(service.accept(prepared()));

    expect(result.created).toBe(false);
    expect(watched.inner.load(HANDOFF_ID)?.revisions).toEqual([result.revision]);
  });

  it('refuses as stale when another writer won the race with other content', () => {
    const rival = { accept: (): void => undefined };
    const watched = watchedStore({ loseSaves: 1, onLostSave: () => rival.accept() });
    rival.accept = () => {
      passed(createAcceptanceService(watched.inner).accept(prepared({ cutoffSequence: 11 })));
    };
    const { service } = setup(watched.store);

    expect(service.accept(prepared())).toEqual(refusal('stale-revision', 'revision-conflict'));
    expect(watched.inner.load(HANDOFF_ID)?.revisions).toHaveLength(1);
  });
});
