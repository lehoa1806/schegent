// FR-R6-F15 T020 — preparation: US1 scenarios 1 to 8 and 10, each row of the Preparation
// table, the rendered bound, the two size limits across a sweep (SC-003) and equal results for
// equal inputs (SC-002).
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { PreparedHandoff } from '../../../src/contracts/phase-context/context-manifest';
import { PHASE_CONTEXT_LIMITS, type ContributionCandidate } from '../../../src/contracts/phase-context/context-policy';
import { parseManifest } from '../../../src/services/phase-context/manifest';
import { parseHandoffPolicy } from '../../../src/services/phase-context/policy';
import { prepareHandoff, type PrepareInput, type PrepareResult } from '../../../src/services/phase-context/preparation';
import { RENDERED_PREAMBLE_BYTES } from '../../../src/services/phase-context/renderer';
import {
  candidate,
  contribution,
  identity,
  identityFor,
  policy,
  producer,
  profile,
  selector,
  textOfBytes
} from '../../fixtures/phase-context/builders';

const INSTRUCTIONS = 'Implement the plan.';
const KIB = 1024;

function input(overrides: Partial<PrepareInput> = {}): PrepareInput {
  const candidates = overrides.candidates ?? [candidate('plan', 1)];
  // A test of malformed candidates passes its own identity: none can be derived from them.
  const derived = 'identity' in overrides || candidates.length === 0 ? identity() : identityFor(candidates);
  return {
    policy: policy(),
    identity: derived,
    cutoffSequence: 10,
    candidates,
    boundInputs: [],
    targetInstructions: INSTRUCTIONS,
    profile: profile(),
    ...overrides
  };
}

function prepared(result: PrepareResult): PreparedHandoff {
  if (result.kind !== 'prepared') throw new Error(`not prepared: ${JSON.stringify(result)}`);
  return result;
}

function refused(failure: string, detail: string): PrepareResult {
  return { kind: 'refused', failure, detail } as PrepareResult;
}

function optional(nodePath: string, priority: number): ReturnType<typeof selector> {
  return selector({ selectorId: `sel-${nodePath}`, sourceNodePath: nodePath, required: false, priority });
}

function required(nodePath: string): ReturnType<typeof selector> {
  return selector({ selectorId: `sel-${nodePath}`, sourceNodePath: nodePath, required: true });
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pathsOf(result: PreparedHandoff): string[] {
  return result.manifest.sources.map((source) => source.producer.nodePath);
}

function omittedOf(result: PreparedHandoff): [string, string][] {
  return result.manifest.omissions.map((entry) => [entry.producer.nodePath, entry.reason]);
}

/** The bytes one candidate adds to the rendered context when it is selected. */
function renderedSizeOf(entry: ContributionCandidate): number {
  const nodePath = entry.acceptedFrom.nodePath;
  const alone = prepared(prepareHandoff(input({ candidates: [entry], policy: policy({ selectors: [required(nodePath)] }) })));
  return alone.rendered.bytes - RENDERED_PREAMBLE_BYTES;
}

describe('prepareHandoff: User Story 1', () => {
  it.each([
    ['undefined', undefined],
    ['null', null]
  ])('prepares no handoff when the policy is %s (scenario 1)', (_label, absent) => {
    expect(prepareHandoff(input({ policy: absent }))).toEqual({ kind: 'no-handoff' });
  });

  it('selects one required and two optional sources that fit, each attributed, with no omission (scenario 2)', () => {
    const candidates = [candidate('plan', 1), candidate('design', 2), candidate('notes', 3)];
    const selectors = [required('plan'), optional('design', 1), optional('notes', 2)];
    const result = prepared(prepareHandoff(input({ candidates, policy: policy({ selectors }) })));
    expect(result.manifest.sources.map((source) => [source.producer, source.required, source.selectedBy.id])).toEqual([
      [producer('plan', 'occ-1', 'att-plan'), true, 'sel-plan'],
      [producer('design', 'occ-1', 'att-design'), false, 'sel-design'],
      [producer('notes', 'occ-1', 'att-notes'), false, 'sel-notes']
    ]);
    expect(result.manifest.omissions).toEqual([]);
    expect(result.manifest.omissionsUnlisted).toBe(0);
  });

  it('leaves out the optional sources of the lowest declared priority, then the latest, each for capacity (scenario 3)', () => {
    const plan = candidate('plan', 1);
    const extra = candidate('extra', 2, { outcomes: [textOfBytes(600)] });
    const design = candidate('design', 3, { outcomes: [textOfBytes(900)] });
    const notes = candidate('notes', 4, { outcomes: ['Short.'] });
    const candidates = [plan, extra, design, notes];
    const selectors = [optional('design', 1), required('plan'), optional('notes', 1), optional('extra', 0)];
    const fitsThree = RENDERED_PREAMBLE_BYTES + renderedSizeOf(plan) + renderedSizeOf(extra) + renderedSizeOf(design);
    const at = (qualifiedContextBytes: number): PreparedHandoff =>
      prepared(prepareHandoff(input({ candidates, policy: policy({ selectors }), profile: profile({ qualifiedContextBytes }) })));

    const three = at(fitsThree);
    expect(pathsOf(three)).toEqual(['plan', 'extra', 'design']);
    expect(omittedOf(three)).toEqual([['notes', 'optional-capacity']]);
    expect(three.rendered.bytes).toBe(fitsThree);

    // One byte less: `design` does not fit, and `notes` after it is not tried though it would fit.
    const two = at(fitsThree - 1);
    expect(pathsOf(two)).toEqual(['plan', 'extra']);
    expect(omittedOf(two)).toEqual([
      ['design', 'optional-capacity'],
      ['notes', 'optional-capacity']
    ]);
    // Nothing is cut: what is selected is carried whole.
    expect(two.manifest.sources.at(1)?.outcomes).toEqual([textOfBytes(600)]);
  });

  it('refuses a required source that does not fit, and cuts nothing (scenario 4)', () => {
    const plan = candidate('plan', 1, { outcomes: [textOfBytes(900)] });
    const exact = RENDERED_PREAMBLE_BYTES + renderedSizeOf(plan);
    expect(prepared(prepareHandoff(input({ candidates: [plan], profile: profile({ qualifiedContextBytes: exact }) }))).rendered.bytes).toBe(exact);
    expect(prepareHandoff(input({ candidates: [plan], profile: profile({ qualifiedContextBytes: exact - 1 }) }))).toEqual(
      refused('capacity-exceeded', 'rendered-bytes')
    );
  });

  it('refuses a required selector with no accepted contribution at the cutoff (scenario 5)', () => {
    expect(prepareHandoff(input({ candidates: [] }))).toEqual(refused('required-context-unavailable', 'no-contribution'));
    expect(prepareHandoff(input({ candidates: [candidate('plan', 11)] }))).toEqual(refused('required-context-unavailable', 'no-contribution'));
  });

  it('omits a contribution accepted after the cutoff, with that reason (scenario 6)', () => {
    const result = prepared(prepareHandoff(input({ candidates: [candidate('plan', 1), candidate('design', 11)] })));
    expect(pathsOf(result)).toEqual(['plan']);
    expect(omittedOf(result)).toEqual([['design', 'after-cutoff']]);
  });

  it('refuses a selector that matches two producer occurrences (scenario 7)', () => {
    const candidates = [candidate('plan', 1, {}, 'occ-1'), candidate('plan', 2, {}, 'occ-2')];
    expect(prepareHandoff(input({ candidates }))).toEqual(refused('invalid-source', 'ambiguous-source'));
  });

  it('gives byte-identical text and one digest for the same inputs, whatever the candidate order (scenario 8, SC-002)', () => {
    const candidates = [candidate('plan', 1), candidate('design', 2), candidate('notes', 3), candidate('late', 11)];
    const selectors = [required('plan'), optional('design', 1), optional('notes', 2)];
    const fixed = identityFor(candidates);
    const first = prepared(prepareHandoff(input({ candidates, identity: fixed, policy: policy({ selectors }) })));
    const second = prepared(prepareHandoff(input({ candidates, identity: fixed, policy: policy({ selectors }) })));
    const reordered = prepared(prepareHandoff(input({ candidates: [...candidates].reverse(), identity: fixed, policy: policy({ selectors }) })));
    expect(second).toEqual(first);
    expect(reordered).toEqual(first);
    expect([second.serialized, second.manifestDigest, second.rendered.text, second.rendered.digestHex]).toEqual([
      first.serialized,
      first.manifestDigest,
      first.rendered.text,
      first.rendered.digestHex
    ]);
  });

  it('refuses a profile with no capacity qualification (scenario 10)', () => {
    expect(prepareHandoff(input({ profile: profile({ qualifiedContextBytes: null }) }))).toEqual(refused('capacity-exceeded', 'profile-unqualified'));
  });
});

describe('prepareHandoff: what a prepared handoff records', () => {
  it('records the identity, the policy, the cutoff, the instructions digest and revision 1', () => {
    const result = prepared(prepareHandoff(input()));
    const parsedPolicy = parseHandoffPolicy(policy());
    expect(result.manifest).toMatchObject({
      manifestVersion: 1,
      revision: 1,
      previousRevision: null,
      origin: 'selected',
      identity: identityFor([candidate('plan', 1)]),
      policyDigest: parsedPolicy.kind === 'valid' ? parsedPolicy.digestHex : '',
      approval: 'automatic',
      session: 'fresh',
      cutoffSequence: 10,
      targetInstructionsDigest: sha256(INSTRUCTIONS),
      renderedBytesMax: 32 * KIB
    });
    expect(result.manifestDigest).toBe(sha256(result.serialized));
    expect(result.rendered.digestHex).toBe(sha256(result.rendered.text));
    expect(result.rendered.bytes).toBe(bytesOf(result.rendered.text));
  });

  it('serializes a manifest that parses back to itself', () => {
    const result = prepared(prepareHandoff(input()));
    expect(parseManifest(JSON.parse(result.serialized))).toEqual({ kind: 'valid', manifest: result.manifest });
  });

  it('carries the approval mode and the session rule of the policy', () => {
    const result = prepared(prepareHandoff(input({ policy: policy({ approval: 'manual', session: 'reuse-when-qualified' }) })));
    expect([result.manifest.approval, result.manifest.session]).toEqual(['manual', 'reuse-when-qualified']);
  });

  it('selects a bound input before any selector', () => {
    const candidates = [candidate('plan', 1), candidate('input', 2)];
    const result = prepared(prepareHandoff(input({ candidates, boundInputs: [{ bindingId: 'bind-input', sourceNodePath: 'input' }] })));
    expect(result.manifest.sources.map((source) => [source.producer.nodePath, source.selectedBy.kind, source.required])).toEqual([
      ['input', 'binding', true],
      ['plan', 'selector', true]
    ]);
  });

  it('prepares a later revision that names the one before it', () => {
    const second = prepared(prepareHandoff(input({ revision: 2 })));
    expect([second.manifest.revision, second.manifest.previousRevision]).toEqual([2, 1]);
    const explicit = prepared(prepareHandoff(input({ revision: 3, previousRevision: 2 })));
    expect([explicit.manifest.revision, explicit.manifest.previousRevision]).toEqual([3, 2]);
  });
});

describe('prepareHandoff: the rows of the table', () => {
  it('refuses a policy of a newer version', () => {
    expect(prepareHandoff(input({ policy: { ...policy(), version: 2 } }))).toEqual(refused('unsupported-version', 'policy-version'));
  });

  it('refuses an invalid policy with the code of what is wrong', () => {
    expect(prepareHandoff(input({ policy: { ...policy(), approval: 'sometimes' } }))).toEqual(refused('invalid-policy', 'approval'));
    expect(prepareHandoff(input({ policy: 'automatic' }))).toEqual(refused('invalid-policy', 'policy-shape'));
  });

  it.each<[string, Partial<PrepareInput>, string]>([
    ['an identity that is not a record', { identity: 'workspace-1' }, 'identity-shape'],
    ['an identity with no source attempt', { identity: identity({ sourceAttempts: [] }) }, 'source-attempt-count'],
    ['bound inputs that are not a list', { boundInputs: { bindingId: 'bind-1', sourceNodePath: 'plan' } }, 'bound-inputs'],
    ['a bound input with a key the contract does not name', { boundInputs: [{ bindingId: 'b', sourceNodePath: 'plan', required: false }] }, 'bound-inputs'],
    ['a negative cutoff', { cutoffSequence: -1 }, 'cutoff'],
    ['a fractional cutoff', { cutoffSequence: 1.5 }, 'cutoff'],
    ['a cutoff that is text', { cutoffSequence: '3' as unknown as number }, 'cutoff'],
    ['candidates that are not a list', { candidates: {} as unknown as ContributionCandidate[], identity: identity() }, 'candidates'],
    ['a candidate that is not a record', { candidates: ['plan'] as unknown as ContributionCandidate[], identity: identity() }, 'candidate'],
    [
      'a candidate with a key the contract does not name',
      { candidates: [{ ...candidate('plan', 1), trusted: true }] as unknown as ContributionCandidate[] },
      'candidate'
    ],
    [
      'a candidate with no accepting attempt',
      { candidates: [{ ...candidate('plan', 1), acceptedFrom: { nodePath: 'plan' } }] as unknown as ContributionCandidate[], identity: identity() },
      'candidate'
    ],
    ['a candidate with a negative sequence', { candidates: [{ ...candidate('plan', 1), acceptedSequence: -1 }] }, 'candidate'],
    ['two candidates from one attempt', { candidates: [candidate('plan', 1), candidate('plan', 2)], identity: identity() }, 'candidate-duplicate'],
    ['instructions that are not text', { targetInstructions: 7 as unknown as string }, 'target-instructions'],
    ['revision 0', { revision: 0 }, 'revision'],
    ['revision 2 that names no earlier revision', { revision: 2, previousRevision: null }, 'revision'],
    ['revision 1 that names an earlier revision', { revision: 1, previousRevision: 1 }, 'revision'],
    ['revision 3 that skips one', { revision: 3, previousRevision: 1 }, 'revision'],
    ['a profile that is not a record', { profile: null as unknown as PrepareInput['profile'] }, 'profile'],
    ['a qualified bound of 0', { profile: profile({ qualifiedContextBytes: 0 }) }, 'profile-bound'],
    ['a negative qualified bound', { profile: profile({ qualifiedContextBytes: -4096 }) }, 'profile-bound'],
    ['a fractional qualified bound', { profile: profile({ qualifiedContextBytes: 4096.5 }) }, 'profile-bound'],
    ['a qualified bound that is not a number', { profile: profile({ qualifiedContextBytes: Number.NaN }) }, 'profile-bound'],
    ['a qualified bound that is text', { profile: profile({ qualifiedContextBytes: '4096' as unknown as number }) }, 'profile-bound']
  ])('refuses %s as an invalid source', (_label, overrides, detail) => {
    expect(prepareHandoff(input(overrides))).toEqual(refused('invalid-source', detail));
  });

  it('accepts 256 candidates and refuses 257', () => {
    const others = (count: number): ContributionCandidate[] =>
      Array.from({ length: count }, (_unused, index) => candidate(`other-${String(index).padStart(3, '0')}`, 2));
    const atLimit = prepared(prepareHandoff(input({ candidates: [candidate('plan', 1), ...others(255)], identity: identity() })));
    expect(pathsOf(atLimit)).toEqual(['plan']);
    expect(atLimit.manifest.omissions).toHaveLength(32);
    expect(atLimit.manifest.omissionsUnlisted).toBe(223);
    expect(prepareHandoff(input({ candidates: [candidate('plan', 1), ...others(256)], identity: identity() }))).toEqual(
      refused('capacity-exceeded', 'candidate-count')
    );
  });

  it('refuses a selected source whose attempt the identity does not name', () => {
    const other = identity({ sourceAttempts: [producer('plan', 'occ-1', 'att-earlier')] });
    expect(prepareHandoff(input({ identity: other }))).toEqual(refused('invalid-source', 'source-not-in-identity'));
  });
});

describe('prepareHandoff: an invalid contribution', () => {
  const broken = (nodePath: string, acceptedSequence: number): ContributionCandidate => ({
    ...candidate(nodePath, acceptedSequence),
    contribution: { ...contribution({ producer: producer(nodePath, 'occ-1', `att-${nodePath}`) }), coverage: 'most' }
  });

  it('refuses the preparation when it is at the cutoff and a request names its node path', () => {
    expect(prepareHandoff(input({ candidates: [broken('plan', 10)] }))).toEqual(refused('invalid-source', 'coverage'));
    const selectors = [required('plan'), optional('design', 1)];
    expect(prepareHandoff(input({ candidates: [candidate('plan', 1), broken('design', 2)], policy: policy({ selectors }) }))).toEqual(
      refused('invalid-source', 'coverage')
    );
  });

  it('refuses a contribution of a newer version as unsupported', () => {
    const newer = { ...candidate('plan', 1), contribution: { ...contribution({ producer: producer('plan', 'occ-1', 'att-plan') }), schemaVersion: 2 } };
    expect(prepareHandoff(input({ candidates: [newer] }))).toEqual(refused('unsupported-version', 'contribution-version'));
  });

  it('refuses a contribution that names another attempt than the one it was accepted from', () => {
    const forged = { ...candidate('plan', 1), contribution: contribution({ producer: producer('plan', 'occ-1', 'att-other') }) };
    expect(prepareHandoff(input({ candidates: [forged] }))).toEqual(refused('invalid-source', 'producer-mismatch'));
  });

  it('lists it as an omission when no request names it or it was accepted after the cutoff', () => {
    const candidates = [candidate('plan', 1), broken('other', 2), broken('design', 11)];
    const selectors = [required('plan'), optional('design', 1)];
    const result = prepared(prepareHandoff(input({ candidates, policy: policy({ selectors }) })));
    expect(pathsOf(result)).toEqual(['plan']);
    expect(omittedOf(result)).toEqual([
      ['design', 'after-cutoff'],
      ['other', 'not-selected-by-policy']
    ]);
  });
});

describe('prepareHandoff: the rendered bound', () => {
  it.each([
    ['the limit when the profile is qualified for more', 64 * KIB, 32 * KIB],
    ['the limit when the profile is qualified for exactly it', 32 * KIB, 32 * KIB],
    ['the qualified bound when it is smaller', 4 * KIB, 4 * KIB]
  ])('is %s', (_label, qualifiedContextBytes, expected) => {
    const result = prepared(prepareHandoff(input({ profile: profile({ qualifiedContextBytes }) })));
    expect(result.manifest.renderedBytesMax).toBe(expected);
  });

  it('refuses a bound the host preamble alone passes, and accepts one it exactly fills', () => {
    const none = policy({ selectors: [optional('design', 0)] });
    const exact = prepared(prepareHandoff(input({ policy: none, candidates: [], profile: profile({ qualifiedContextBytes: RENDERED_PREAMBLE_BYTES }) })));
    expect(exact.rendered.bytes).toBe(RENDERED_PREAMBLE_BYTES);
    expect(exact.manifest.sources).toEqual([]);
    expect(prepareHandoff(input({ policy: none, candidates: [], profile: profile({ qualifiedContextBytes: RENDERED_PREAMBLE_BYTES - 1 }) }))).toEqual(
      refused('capacity-exceeded', 'rendered-bound')
    );
  });
});

describe('prepareHandoff: the two size limits (SC-003)', () => {
  const longPath = (index: number): string => `phase-${String(index).padStart(2, '0')}-${'n'.repeat(240)}`;
  const wide = (index: number, entryBytes: number, fill: string): ContributionCandidate => {
    const acceptedFrom = producer(longPath(index), `occ-${'o'.repeat(120)}`, `att-${String(index).padStart(2, '0')}-${'t'.repeat(116)}`);
    return { acceptedFrom, acceptedSequence: 1, contribution: contribution({ producer: acceptedFrom, outcomes: [textOfBytes(entryBytes, fill)], decisions: [], constraints: [] }) };
  };

  it('refuses a required source the manifest limit cannot hold though the rendered bound can', () => {
    // A quotation mark is one byte rendered and two in the serialized manifest, and an identity
    // of many attempts is in the manifest only: together they pass 64 KiB under a 32 KiB bound.
    const earlier = Array.from({ length: 20 }, (_unused, index) => producer(`earlier-${String(index).padStart(2, '0')}-${'n'.repeat(200)}`, 'occ-1', `att-${index}`));
    const wide = identity({ sourceAttempts: [producer('plan', 'occ-1', 'att-plan'), ...earlier] });
    const withFill = (fill: string): PrepareInput => {
      const outcomes = Array.from({ length: 16 }, () => textOfBytes(2000, fill));
      return input({ candidates: [candidate('plan', 1, { outcomes, decisions: [], constraints: [] })], identity: wide });
    };
    const plain = prepared(prepareHandoff(withFill('a')));
    expect(plain.rendered.bytes).toBeGreaterThan(32_000);
    expect(bytesOf(plain.serialized)).toBeLessThan(PHASE_CONTEXT_LIMITS.manifestBytesMax);
    expect(prepareHandoff(withFill('"'))).toEqual(refused('capacity-exceeded', 'manifest-bytes'));
  });

  it.each([
    ['plain text', 'a'],
    ['text the serialized manifest escapes', '"']
  ])('never passes 64 KiB serialized or the rendered bound, with %s', (_label, fill) => {
    const seen = new Set<string>();
    for (const count of [1, 7, 16, 32]) {
      for (const entryBytes of [1, 300, 900, 1500, 2048]) {
        for (const qualifiedContextBytes of [2 * KIB, 9 * KIB, 32 * KIB, 64 * KIB]) {
          const candidates = Array.from({ length: count }, (_unused, index) => wide(index, entryBytes, fill));
          const selectors = candidates.map((entry, index) =>
            selector({ selectorId: `sel-${String(index).padStart(2, '0')}`, sourceNodePath: entry.acceptedFrom.nodePath, required: false, priority: index % 3 })
          );
          const result = prepared(
            prepareHandoff(input({ candidates, policy: policy({ selectors }), profile: profile({ qualifiedContextBytes }) }))
          );
          expect(bytesOf(result.serialized)).toBeLessThanOrEqual(PHASE_CONTEXT_LIMITS.manifestBytesMax);
          expect(result.rendered.bytes).toBeLessThanOrEqual(result.manifest.renderedBytesMax);
          expect(result.manifest.sources.length + result.manifest.omissions.length + result.manifest.omissionsUnlisted).toBe(count);
          expect(parseManifest(JSON.parse(result.serialized)).kind).toBe('valid');
          for (const entry of result.manifest.omissions) seen.add(entry.reason);
          seen.add(result.manifest.sources.length === count ? 'all-selected' : 'some-omitted');
        }
      }
    }
    // The sweep reaches both sides of the limits, or it proves nothing about them.
    expect([...seen].sort()).toEqual(['all-selected', 'optional-capacity', 'some-omitted']);
  });
});
