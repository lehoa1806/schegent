// FR-R6-F15 T036 — explanation and observation: a handoff and a review loop explained from
// metadata alone (FR-019, FR-034), the key under which two observations of one transfer count
// once (FR-022), the 64 KiB bound, and a marker seeded in every entry, summary, title and
// finding explanation that reaches no explanation and no observation (SC-007).
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  HANDOFF_EVENTS,
  type HandoffEvent,
  type HandoffRecord,
  type ManifestSource,
  type PreparedHandoff
} from '../../../src/contracts/phase-context/context-manifest';
import { PHASE_CONTEXT_LIMITS } from '../../../src/contracts/phase-context/context-policy';
import { createAcceptanceService, soundRecord, type AcceptanceService } from '../../../src/services/phase-context/acceptance';
import { explainHandoff, explainReviewLoop, observationOf, observePrepared } from '../../../src/services/phase-context/explanation';
import { createFindingLedger, type FindingLedger } from '../../../src/services/phase-context/finding-ledger';
import { buildManifest, manifestDigestOf, serializeManifest, type ManifestInput } from '../../../src/services/phase-context/manifest';
import { createMemoryHandoffStore } from '../../../src/services/phase-context/memory-store';
import { renderContext } from '../../../src/services/phase-context/renderer';
import {
  artifactRef,
  digestOf,
  finding,
  fixClaims,
  manifestInput,
  manifestSource,
  marker,
  omission,
  producer,
  reviewReport,
  textOfBytes
} from '../../fixtures/phase-context/builders';

const SEED = marker('explained');
const SEED_WORD = 'SEEDED';
const REPRESENTATION = digestOf('d');
const DELIVERED_ATTEMPT = 'att-implement-1';
const UNCERTAIN_ATTEMPT = 'att-implement-2';
const INTENT_ATTEMPT = 'att-implement-3';
const DISPATCH_EVENTS: readonly HandoffEvent[] = ['dispatch-intent', 'delivered', 'uncertain'];

function prepared(overrides: Partial<ManifestInput> = {}, sources: readonly ManifestSource[] = [manifestSource()]): PreparedHandoff {
  const manifest = buildManifest(manifestInput(sources, overrides));
  const serialized = serializeManifest(manifest);
  return { manifest, serialized, manifestDigest: manifestDigestOf(serialized), rendered: renderContext(manifest) };
}

function passed<T extends { readonly ok: boolean }>(result: T): Extract<T, { readonly ok: true }> {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { readonly ok: true }>;
}

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function recordOf(service: AcceptanceService, handoffId: string): HandoffRecord {
  const { record } = passed(service.inspect(handoffId));
  if (record === null) throw new Error('expected a record');
  return record;
}

/** The record of a handoff after each prepared revision was accepted in turn. */
function accepted(...revisions: readonly PreparedHandoff[]): { service: AcceptanceService; record: HandoffRecord; handoffId: string } {
  const service = createAcceptanceService(createMemoryHandoffStore());
  for (const revision of revisions) passed(service.accept(revision));
  const handoffId = revisions.at(0)?.manifest.handoffId ?? '';
  return { service, record: recordOf(service, handoffId), handoffId };
}

const plan = manifestSource('plan', {
  outcomes: ['The plan lists four steps.', 'Step two is done.'],
  decisions: ['Keep the queue.'],
  summary: 'A plan of four steps.',
  artifacts: [artifactRef()]
});
const research = manifestSource('research', {
  required: false,
  coverage: 'partial',
  selectedBy: { kind: 'binding', id: 'input-research' },
  outcomes: [],
  constraints: ['No new dependency.'],
  unresolvedIssues: ['The retry count is open.', 'The owner is unknown.', 'The date is open.']
});
const listedOmissions = [
  omission('audit'),
  omission('notes', { request: { kind: 'selector', id: 'sel-notes' }, reason: 'optional-capacity' })
];

function described(): PreparedHandoff {
  return prepared({ omissions: listedOmissions, omissionsUnlisted: 3 }, [plan, research]);
}

/**
 * A manual handoff where every event happened to revision 1: accepted, approved, one attempt
 * delivered, one uncertain, one still an intent, and then superseded by revision 2.
 */
function eventful(sources: readonly ManifestSource[] = [plan, research]): { record: HandoffRecord; first: PreparedHandoff; handoffId: string } {
  const first = prepared({ approval: 'manual', omissions: listedOmissions, omissionsUnlisted: 3 }, sources);
  const { service, handoffId } = accepted(first);
  passed(service.approve(handoffId, 1, 'decision-1'));
  for (const attempt of [DELIVERED_ATTEMPT, UNCERTAIN_ATTEMPT, INTENT_ATTEMPT]) {
    passed(service.recordDispatchIntent(handoffId, 1, attempt, REPRESENTATION));
  }
  passed(service.settleDispatch(handoffId, 1, DELIVERED_ATTEMPT, 'delivered'));
  passed(service.settleDispatch(handoffId, 1, UNCERTAIN_ATTEMPT, 'uncertain'));
  passed(service.accept(prepared({ approval: 'manual', revision: 2, previousRevision: 1 }, sources)));
  return { record: recordOf(service, handoffId), first, handoffId };
}

/** The attempt that makes each event observable in the eventful record. */
function attemptFor(event: HandoffEvent): string | undefined {
  if (event === 'delivered') return DELIVERED_ATTEMPT;
  if (event === 'uncertain') return UNCERTAIN_ATTEMPT;
  return event === 'dispatch-intent' ? INTENT_ATTEMPT : undefined;
}

/** A list of one entry that was never set. */
function listWithHole(): never[] {
  const list: never[] = [];
  list.length = 1;
  return list;
}

/** The record with every revision holding the text, under the digest of that text unless one is given. */
function withStoredText(record: HandoffRecord, text: string, manifestDigest: string = manifestDigestOf(text)): HandoffRecord {
  return { ...record, revisions: record.revisions.map((entry) => ({ ...entry, serializedManifest: text, manifestDigest })) };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('explainHandoff', () => {
  it('lists each source and omission by identity and reason, with counts in place of text', () => {
    const first = described();
    const { record, handoffId } = accepted(first);

    expect(explainHandoff(record)).toEqual({
      ok: true,
      explanation: {
        handoffId,
        recordVersion: record.version,
        identity: first.manifest.identity,
        revisions: [
          {
            revision: 1,
            manifestDigest: first.manifestDigest,
            rendererVersion: 1,
            renderedDigest: first.rendered.digestHex,
            renderedBytes: first.rendered.bytes,
            state: 'ready'
          }
        ],
        revision: 1,
        origin: 'selected',
        approval: 'automatic',
        session: 'fresh',
        policyDigest: digestOf('b'),
        cutoffSequence: 10,
        renderedBytesMax: 32 * 1024,
        sources: [
          {
            producer: producer('plan', 'occ-1', 'att-plan'),
            coverage: 'complete',
            required: true,
            selectedBy: { kind: 'selector', id: 'sel-plan' },
            outcomes: 2,
            decisions: 1,
            constraints: 0,
            unresolvedIssues: 0,
            hasSummary: true,
            artifacts: 1
          },
          {
            producer: producer('research', 'occ-1', 'att-research'),
            coverage: 'partial',
            required: false,
            selectedBy: { kind: 'binding', id: 'input-research' },
            outcomes: 0,
            decisions: 0,
            constraints: 1,
            unresolvedIssues: 3,
            hasSummary: false,
            artifacts: 0
          }
        ],
        omissions: listedOmissions,
        omissionsUnlisted: 3,
        approvals: [],
        dispatches: []
      }
    });
  });

  it('explains the latest revision unless another is named', () => {
    const first = prepared({}, [plan, research]);
    const second = prepared({ revision: 2, previousRevision: 1, origin: 'edited', identity: first.manifest.identity }, [plan]);
    const { record } = accepted(first, second);

    const latest = passed(explainHandoff(record)).explanation;
    const earlier = passed(explainHandoff(record, 1)).explanation;

    expect(latest.revisions.map((entry) => `${String(entry.revision)}:${entry.state}`)).toEqual(['1:superseded', '2:ready']);
    expect([latest.revision, latest.origin, latest.sources.length]).toEqual([2, 'edited', 1]);
    expect([earlier.revision, earlier.origin, earlier.sources.length]).toEqual([1, 'selected', 2]);
    expect(earlier.revisions).toEqual(latest.revisions);
  });

  it('shows the approvals and dispatches of the record as they are stored', () => {
    const { record } = eventful();

    const { explanation } = passed(explainHandoff(record, 1));

    expect(explanation.approval).toBe('manual');
    expect(explanation.approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
    expect(explanation.dispatches).toEqual(record.dispatches);
    expect(explanation.dispatches.map((entry) => entry.state)).toEqual(['delivered', 'uncertain', 'intent']);
    expect(explanation.revisions.map((entry) => entry.state)).toEqual(['superseded', 'waiting-approval']);
  });

  it('gives equal explanations for equal records', () => {
    const { record } = eventful();

    expect(JSON.stringify(explainHandoff(record))).toBe(JSON.stringify(explainHandoff(record)));
  });

  it.each([
    ['a revision past the last', 7],
    ['revision zero', 0],
    ['a revision that is not a whole number', 1.5]
  ])('refuses %s as an unknown revision', (_label, revision) => {
    expect(explainHandoff(accepted(described()).record, revision)).toEqual(refusal('stale-revision', 'unknown-revision'));
  });

  it('refuses a record that holds no revision', () => {
    const { record } = accepted(described());

    expect(explainHandoff({ ...record, revisions: [] })).toEqual(refusal('stale-revision', 'unknown-revision'));
  });

  it.each([
    ['is not JSON', '{'],
    ['is not a manifest', '{}'],
    ['is the manifest of another handoff', prepared({}, [manifestSource('audit')]).serialized],
    ['is the manifest of another revision', prepared({ revision: 2, previousRevision: 1 }, [plan, research]).serialized]
  ])('refuses a revision whose stored text %s', (_label, text) => {
    const { record } = accepted(prepared({}, [plan, research]));

    expect(explainHandoff(withStoredText(record, text))).toEqual(refusal('storage-unavailable', 'stored-manifest'));
  });

  it('refuses a revision whose stored text is not the text its digest was taken of', () => {
    const { record } = accepted(prepared({}, [plan, research]));
    const other = prepared({}, [{ ...plan, outcomes: ['Another outcome.'] }, research]);
    const recorded = record.revisions.at(0)?.manifestDigest ?? '';

    expect(other.manifest.handoffId).toBe(record.handoffId);
    expect(other.manifestDigest).not.toBe(recorded);
    expect(explainHandoff(withStoredText(record, other.serialized, recorded))).toEqual(refusal('storage-unavailable', 'stored-manifest'));
    expect(observationOf('accepted', withStoredText(record, other.serialized, recorded), 1)).toBeNull();
  });

  it('reads a stored text of exactly 64 KiB and refuses one byte more, whatever its digest says', () => {
    const { record } = accepted(prepared({}, [plan, research]));
    const text = record.revisions.at(0)?.serializedManifest ?? '';
    const paddedTo = (bytes: number): string => text + ' '.repeat(bytes - Buffer.byteLength(text, 'utf8'));

    expect(explainHandoff(withStoredText(record, paddedTo(PHASE_CONTEXT_LIMITS.manifestBytesMax))).ok).toBe(true);
    expect(explainHandoff(withStoredText(record, paddedTo(PHASE_CONTEXT_LIMITS.manifestBytesMax + 1)))).toEqual(
      refusal('storage-unavailable', 'stored-manifest')
    );
  });

  it('refuses a revision whose stored text is a list holding the text', () => {
    const { record } = accepted(prepared({}, [plan, research]));
    const altered = { ...record, revisions: record.revisions.map((entry) => ({ ...entry, serializedManifest: [entry.serializedManifest] as never })) };

    expect(explainHandoff(altered)).toEqual(refusal('storage-unavailable', 'stored-manifest'));
  });

  it.each<[string, (record: HandoffRecord) => HandoffRecord]>([
    ['an approval whose decision id is prose', (record) => ({ ...record, approvals: [{ revision: 1, decisionId: `${SEED} was decided` }] })],
    ['an approval of revision zero', (record) => ({ ...record, approvals: [{ revision: 0, decisionId: 'decision-1' }] })],
    ['a dispatch whose attempt id is prose', (record) => ({ ...record, dispatches: record.dispatches.map((entry) => ({ ...entry, targetAttemptId: 'not an id' })) })],
    ['a dispatch whose representation is not a digest', (record) => ({ ...record, dispatches: record.dispatches.map((entry) => ({ ...entry, representationDigest: SEED })) })],
    ['a dispatch in a state the contract does not name', (record) => ({ ...record, dispatches: record.dispatches.map((entry) => ({ ...entry, state: 'sent' as never })) })],
    ['a revision in a state the contract does not name', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, state: 'draft' as never })) })],
    ['a revision whose manifest digest is not a digest', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, manifestDigest: SEED })) })],
    ['a revision whose rendered digest is not a digest', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, renderedDigest: 'abc' })) })],
    ['a revision with a rendered size that is not a whole number', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, renderedBytes: 1.5 })) })],
    ['a handoff id that is not a digest', (record) => ({ ...record, handoffId: SEED })],
    ['a version that is not a whole number', (record) => ({ ...record, version: -1 })],
    ['more than 16 revisions', (record) => ({ ...record, revisions: Array.from({ length: 17 }, () => record.revisions).flat() })],
    ['more than 64 dispatches', (record) => ({ ...record, dispatches: Array.from({ length: 22 }, () => record.dispatches).flat() })],
    ['approvals that are not a list', (record) => ({ ...record, approvals: 'none' as never })],
    ['a revision numbered zero', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, revision: 0 })) })],
    ['a revision of renderer version zero', (record) => ({ ...record, revisions: record.revisions.map((entry) => ({ ...entry, rendererVersion: 0 })) })],
    ['a dispatch of revision zero', (record) => ({ ...record, dispatches: record.dispatches.map((entry) => ({ ...entry, revision: 0 })) })],
    ['two revisions stored in reverse order', (record) => ({ ...record, revisions: [...record.revisions].reverse() })],
    ['a second revision numbered 3', (record) => ({ ...record, revisions: record.revisions.map((entry, index) => ({ ...entry, revision: index === 0 ? 1 : 3 })) })],
    ['a revision entry that is null', (record) => ({ ...record, revisions: [null as never] })],
    ['a revision entry that is a list', (record) => ({ ...record, revisions: [[] as never] })],
    ['an approval entry that is null', (record) => ({ ...record, approvals: [null as never] })],
    ['a dispatch entry that is missing', (record) => ({ ...record, dispatches: [undefined as never] })],
    ['a revision entry that was never set', (record) => ({ ...record, revisions: listWithHole() })],
    ['a dispatch entry that was never set', (record) => ({ ...record, dispatches: listWithHole() })],
    ['nothing in place of the record', () => null as never],
    ['a list in place of the record', () => [] as never]
  ])('refuses a record with %s, and observes nothing of it', (_label, alter) => {
    const altered = alter(eventful().record);

    const explained = explainHandoff(altered);

    expect(explained).toEqual(refusal('storage-unavailable', 'stored-record'));
    expect(JSON.stringify(explained)).not.toContain(SEED_WORD);
    expect(observationOf('accepted', altered, 1)).toBeNull();
  });

  it('takes a record of exactly 16 revisions, 16 approvals and 64 dispatches, and refuses one more of any', () => {
    const { record } = eventful();
    const repeated = <T>(list: readonly T[], length: number): T[] => Array.from({ length }, () => list).flat().slice(0, length);
    const sized = (revisions: number, approvals: number, dispatches: number): HandoffRecord => ({
      ...record,
      revisions: repeated(record.revisions, revisions).map((entry, index) => ({ ...entry, revision: index + 1 })),
      approvals: repeated(record.approvals, approvals),
      dispatches: repeated(record.dispatches, dispatches)
    });
    const { revisionsMax, dispatchesMax } = PHASE_CONTEXT_LIMITS;

    expect([revisionsMax, dispatchesMax]).toEqual([16, 64]);
    expect([record.revisions.length, record.approvals.length, record.dispatches.length]).toEqual([2, 1, 3]);
    expect(soundRecord(sized(revisionsMax, revisionsMax, dispatchesMax))).toBe(true);
    expect(soundRecord(sized(revisionsMax + 1, revisionsMax, dispatchesMax))).toBe(false);
    expect(soundRecord(sized(revisionsMax, revisionsMax + 1, dispatchesMax))).toBe(false);
    expect(soundRecord(sized(revisionsMax, revisionsMax, dispatchesMax + 1))).toBe(false);
  });

  it('stays within 64 KiB for a record of 16 revisions of the largest rendered size', () => {
    const entries = Array.from({ length: 15 }, (_unused, index) => textOfBytes(1_997, 'a') + String(index).padStart(3, '0'));
    const wide = (revision: number): PreparedHandoff =>
      prepared({ revision, previousRevision: revision === 1 ? null : revision - 1 }, [manifestSource('plan', { outcomes: entries })]);
    const { record } = accepted(...Array.from({ length: PHASE_CONTEXT_LIMITS.revisionsMax }, (_unused, index) => wide(index + 1)));

    const { explanation } = passed(explainHandoff(record));

    expect(record.revisions).toHaveLength(16);
    expect(record.revisions.at(-1)?.renderedBytes).toBeGreaterThan(30_000);
    expect(bytesOf(explanation)).toBeLessThanOrEqual(64 * 1024);
    expect(explanation.revisions).toHaveLength(16);
  });

  it('refuses an explanation over 64 KiB and explains the same record once it is under', () => {
    const long = (label: string, length: number): string => label + 'n'.repeat(length - label.length);
    const sources = Array.from({ length: 32 }, (_unused, index) => {
      const tag = `s${String(index).padStart(2, '0')}-`;
      return manifestSource('plan', {
        producer: producer(long(tag, 250), long(tag, 120), long(tag, 120)),
        selectedBy: { kind: 'selector', id: long(tag, 120) },
        outcomes: ['x']
      });
    });
    const omissions = Array.from({ length: 20 }, (_unused, index) => {
      const tag = `o${String(index).padStart(2, '0')}-`;
      return omission('audit', { producer: producer(long(tag, 250), long(tag, 120), long(tag, 120)), request: { kind: 'selector', id: long(tag, 120) } });
    });
    const { service, handoffId } = accepted(prepared({ omissions }, sources));
    for (let index = 0; index < PHASE_CONTEXT_LIMITS.dispatchesMax; index += 1) {
      passed(service.recordDispatchIntent(handoffId, 1, long(`t${String(index).padStart(2, '0')}-`, 120), REPRESENTATION));
    }
    const record = recordOf(service, handoffId);

    expect(explainHandoff(record)).toEqual(refusal('capacity-exceeded', 'explanation-bytes'));

    const under = passed(explainHandoff({ ...record, dispatches: [] })).explanation;
    expect(bytesOf(under)).toBeLessThanOrEqual(64 * 1024);
    expect(bytesOf(under)).toBeGreaterThan(48 * 1024);
  });
});

describe('observationOf', () => {
  it('describes an event of a revision by counts and sizes', () => {
    const first = described();
    const { record, handoffId } = accepted(first);

    expect(observationOf('accepted', record, 1)).toEqual({
      key: createHash('sha256').update(JSON.stringify(['pco1', handoffId, 1, 'accepted', '']), 'utf8').digest('hex'),
      event: 'accepted',
      handoffId,
      revision: 1,
      sourceCount: 2,
      omissionCount: 5,
      renderedBytes: first.rendered.bytes
    });
  });

  it.each(HANDOFF_EVENTS.map((event) => [event] as const))('observes %s once it is in the record', (event) => {
    const { record, handoffId } = eventful();

    const observation = observationOf(event, record, 1, attemptFor(event));

    expect(observation).toMatchObject({ event, handoffId, revision: 1, sourceCount: 2, omissionCount: 5 });
    expect(observation?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives two observations of one transfer the same key, whatever was stored in between', () => {
    const first = prepared({}, [plan]);
    const { service, handoffId } = accepted(first);
    passed(service.recordDispatchIntent(handoffId, 1, DELIVERED_ATTEMPT, REPRESENTATION));
    passed(service.settleDispatch(handoffId, 1, DELIVERED_ATTEMPT, 'delivered'));
    const before = observationOf('delivered', recordOf(service, handoffId), 1, DELIVERED_ATTEMPT);
    passed(service.recordDispatchIntent(handoffId, 1, INTENT_ATTEMPT, REPRESENTATION));
    passed(service.accept(prepared({ revision: 2, previousRevision: 1 }, [plan])));

    const after = observationOf('delivered', recordOf(service, handoffId), 1, DELIVERED_ATTEMPT);

    expect(before).not.toBeNull();
    expect(after).toEqual(before);
  });

  it('gives each revision, event, attempt and handoff its own key', () => {
    const { record } = eventful();
    const other = eventful([manifestSource('audit')]).record;
    const keys = [
      observationOf('accepted', record, 1),
      observationOf('accepted', record, 2),
      observationOf('prepared', record, 1),
      observationOf('accepted', other, 1),
      observationOf('dispatch-intent', record, 1, DELIVERED_ATTEMPT),
      observationOf('dispatch-intent', record, 1, UNCERTAIN_ATTEMPT),
      observationOf('delivered', record, 1, DELIVERED_ATTEMPT)
    ].map((observation) => observation?.key);

    expect(keys.every((key) => typeof key === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys an event that is not a dispatch without the attempt', () => {
    const { record } = eventful();

    expect(observationOf('accepted', record, 1, DELIVERED_ATTEMPT)).toEqual(observationOf('accepted', record, 1));
    expect(observationOf('approved', record, 1, 'att-other')).toEqual(observationOf('approved', record, 1));
  });

  it('observes the intent of a dispatch that has since been settled', () => {
    const { record } = eventful();

    expect(observationOf('dispatch-intent', record, 1, DELIVERED_ATTEMPT)?.event).toBe('dispatch-intent');
    expect(observationOf('dispatch-intent', record, 1, UNCERTAIN_ATTEMPT)?.event).toBe('dispatch-intent');
  });

  it.each([
    ['an event the contract does not name', 'sent', 1, undefined],
    ['a revision the record does not hold', 'accepted', 9, undefined],
    ['a revision that is not a whole number', 'accepted', 1.5, undefined],
    ['an approval that was not given', 'approved', 2, undefined],
    ['the current revision as superseded', 'superseded', 2, undefined],
    ['a dispatch with no attempt', 'dispatch-intent', 1, undefined],
    ['a dispatch with an attempt that is not an identifier', 'dispatch-intent', 1, 'not an id'],
    ['a dispatch of an attempt the record does not hold', 'dispatch-intent', 1, 'att-unknown'],
    ['a dispatch of another revision', 'dispatch-intent', 2, DELIVERED_ATTEMPT],
    ['a delivery that is still an intent', 'delivered', 1, INTENT_ATTEMPT],
    ['a delivery that is uncertain', 'delivered', 1, UNCERTAIN_ATTEMPT],
    ['an uncertain outcome that was delivered', 'uncertain', 1, DELIVERED_ATTEMPT],
    ['an uncertain outcome that is still an intent', 'uncertain', 1, INTENT_ATTEMPT]
  ])('observes nothing for %s', (_label, event, revision, attempt) => {
    expect(observationOf(event as HandoffEvent, eventful().record, revision, attempt)).toBeNull();
  });

  it('observes nothing when the stored text of the revision is not its manifest', () => {
    const { record } = accepted(described());

    expect(observationOf('accepted', withStoredText(record, '{'), 1)).toBeNull();
    expect(observationOf('accepted', withStoredText(record, prepared({}, [manifestSource('audit')]).serialized), 1)).toBeNull();
  });

  it('covers the three dispatch events and no other with an attempt', () => {
    const { record } = eventful();
    const keyed = HANDOFF_EVENTS.filter((event) => {
      const plain = observationOf(event, record, 1);
      const withAttempt = observationOf(event, record, 1, attemptFor(event) ?? DELIVERED_ATTEMPT);
      return plain?.key !== withAttempt?.key;
    });

    expect(keyed).toEqual(DISPATCH_EVENTS);
  });
});

describe('observePrepared', () => {
  it('observes a prepared handoff before it is accepted, under the key it keeps afterwards', () => {
    const first = described();

    const observation = observePrepared(first);

    expect(observation).toEqual({
      key: observation.key,
      event: 'prepared',
      handoffId: first.manifest.handoffId,
      revision: 1,
      sourceCount: 2,
      omissionCount: 5,
      renderedBytes: first.rendered.bytes
    });
    expect(observationOf('prepared', accepted(first).record, 1)).toEqual(observation);
  });
});

function ledgerOf(): FindingLedger {
  return createFindingLedger({ loopId: 'loop-1', blockingSeverities: ['critical', 'high'], maxPasses: 8 });
}

/** A loop of two passes: `F-1` opened, claimed fixed and resolved; `F-2` opened in pass 2. */
function reviewedLedger(): FindingLedger {
  const ledger = ledgerOf();
  passed(
    ledger.acceptReport(reviewReport({ findings: [finding({ title: SEED, explanation: SEED })] }), {
      reportRef: 'report@1',
      candidateRef: 'candidate@1',
      scopeRevision: 'scope@1',
      criteriaRevision: 'criteria@1'
    })
  );
  passed(ledger.recordClaims(fixClaims(), { candidateRef: 'candidate@1' }));
  passed(
    ledger.acceptReport(
      reviewReport({
        pass: 2,
        previousReportRef: 'report@1',
        reviewPassed: true,
        blockingCount: 0,
        findings: [finding({ id: 'F-2', severity: 'info', title: SEED, explanation: SEED })],
        dispositions: [{ findingId: 'F-1', status: 'resolved' }]
      }),
      { reportRef: 'report@2', candidateRef: 'candidate@1', scopeRevision: 'scope@1', criteriaRevision: 'criteria@1' }
    )
  );
  return ledger;
}

describe('explainReviewLoop', () => {
  it('explains a loop of no pass', () => {
    expect(explainReviewLoop(ledgerOf(), 'loop-1')).toEqual({
      loopId: 'loop-1',
      passes: 0,
      latestVerdict: null,
      blockingCount: 0,
      open: 0,
      resolved: 0,
      findings: []
    });
  });

  it('gives each finding its identity, severity, status, opening pass and claim kinds', () => {
    expect(explainReviewLoop(reviewedLedger(), 'loop-1')).toEqual({
      loopId: 'loop-1',
      passes: 2,
      latestVerdict: 'passed',
      blockingCount: 0,
      open: 1,
      resolved: 1,
      findings: [
        { id: 'F-1', severity: 'high', status: 'resolved', openedInPass: 1, claims: ['claimed-fixed'] },
        { id: 'F-2', severity: 'info', status: 'open', openedInPass: 2, claims: [] }
      ]
    });
  });

  it('reports the verdict and counts of the latest pass', () => {
    const ledger = ledgerOf();
    passed(
      ledger.acceptReport(reviewReport(), {
        reportRef: 'report@1',
        candidateRef: 'candidate@1',
        scopeRevision: 'scope@1',
        criteriaRevision: 'criteria@1'
      })
    );

    expect(explainReviewLoop(ledger, 'loop-1')).toMatchObject({ passes: 1, latestVerdict: 'needs-fixes', blockingCount: 1, open: 1, resolved: 0 });
  });

  it.each([
    ['prose', 'a loop with a title'],
    ['an empty id', ''],
    ['a seeded marker', SEED],
    ['an id over 128 characters', 'l'.repeat(129)]
  ])('explains nothing under a loop id that is %s', (_label, loopId) => {
    expect(explainReviewLoop(reviewedLedger(), loopId)).toBeNull();
  });
});

describe('a seeded marker (SC-007)', () => {
  const seededSource = manifestSource('plan', {
    outcomes: [SEED],
    decisions: [SEED],
    constraints: [SEED],
    unresolvedIssues: [SEED],
    summary: SEED
  });

  it('is in the stored manifest and the rendered context, so its absence below means something', () => {
    const { first } = eventful([seededSource]);

    expect(first.serialized.split(SEED).length - 1).toBe(5);
    expect(first.rendered.text).toContain(SEED);
    expect(SEED).toContain(SEED_WORD);
  });

  it('appears in no explanation of the handoff', () => {
    const { record } = eventful([seededSource]);

    const explanations = [explainHandoff(record), explainHandoff(record, 1)];

    expect(explanations.map((entry) => entry.ok)).toEqual([true, true]);
    expect(JSON.stringify(explanations)).not.toContain(SEED_WORD);
  });

  it('appears in no observation of any event', () => {
    const { record, first } = eventful([seededSource]);

    const observations = [observePrepared(first), ...HANDOFF_EVENTS.map((event) => observationOf(event, record, 1, attemptFor(event)))];

    expect(observations.filter((entry) => entry !== null)).toHaveLength(HANDOFF_EVENTS.length + 1);
    expect(JSON.stringify(observations)).not.toContain(SEED_WORD);
  });

  it('appears in no explanation of the review loop', () => {
    const explanation = explainReviewLoop(reviewedLedger(), 'loop-1');

    expect(explanation?.findings).toHaveLength(2);
    expect(JSON.stringify(explanation)).not.toContain(SEED_WORD);
    expect(explanation?.findings.map((entry) => Object.keys(entry).sort())).toEqual([
      ['claims', 'id', 'openedInPass', 'severity', 'status'],
      ['claims', 'id', 'openedInPass', 'severity', 'status']
    ]);
  });
});
