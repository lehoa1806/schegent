// FR-R6-F15 T014 — selection: every row of the Selection table, the order of requests, the
// prefix rule for optional context, the count limits and the order of the omissions.
import { describe, expect, it } from 'vitest';

import type { ManifestSource } from '../../../src/contracts/phase-context/context-manifest';
import type { SourceContribution } from '../../../src/contracts/phase-context/context-policy';
import { selectSources, type SelectionInput, type SelectionResult, type ValidCandidate } from '../../../src/services/phase-context/selection';
import { artifactRef, contribution, policy, producer, selector } from '../../fixtures/phase-context/builders';

const FIXED_COST = { manifestBytes: 100, renderedBytes: 100 };

function valid(nodePath: string, acceptedSequence = 1, overrides: Partial<SourceContribution> = {}, occurrenceId = 'occ-1'): ValidCandidate {
  const acceptedFrom = producer(nodePath, occurrenceId, `att-${nodePath}`);
  return { acceptedFrom, acceptedSequence, contribution: contribution({ producer: acceptedFrom, ...overrides }) };
}

function invalidCandidate(nodePath: string, acceptedSequence = 1): ValidCandidate {
  return { acceptedFrom: producer(nodePath, 'occ-1', `att-${nodePath}`), acceptedSequence, contribution: null };
}

function optional(nodePath: string, priority = 0): ReturnType<typeof selector> {
  return selector({ selectorId: `sel-${nodePath}`, sourceNodePath: nodePath, required: false, priority });
}

function required(nodePath: string): ReturnType<typeof selector> {
  return selector({ selectorId: `sel-${nodePath}`, sourceNodePath: nodePath, required: true });
}

function select(overrides: Partial<SelectionInput> = {}): ReturnType<typeof selectSources> {
  return selectSources({
    policy: policy(),
    boundInputs: [],
    candidates: [valid('plan')],
    cutoffSequence: 10,
    manifestBytesBudget: 1_000_000,
    renderedBytesBudget: 1_000_000,
    costOf: () => FIXED_COST,
    ...overrides
  });
}

function accepted(result: ReturnType<typeof selectSources>): SelectionResult {
  if (!result.ok) throw new Error(`selection refused: ${result.failure} ${result.detail}`);
  return result;
}

function pathsOf(sources: readonly ManifestSource[]): string[] {
  return sources.map((source) => source.producer.nodePath);
}

function nodes(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

describe('selectSources: the rows of the table', () => {
  it('selects the one candidate a required selector names, attributed to its producer attempt', () => {
    const result = accepted(select());
    expect(result.sources).toEqual([
      {
        producer: producer('plan', 'occ-1', 'att-plan'),
        acceptedSequence: 1,
        coverage: 'complete',
        required: true,
        selectedBy: { kind: 'selector', id: 'sel-plan' },
        outcomes: ['The plan lists four steps.'],
        decisions: ['Use the existing queue.'],
        constraints: ['Do not change the public contract.'],
        unresolvedIssues: [],
        summary: null,
        artifacts: []
      }
    ]);
    expect(result.omissions).toEqual([]);
    expect(result.omissionsUnlisted).toBe(0);
  });

  it('refuses a required request that matches no candidate at the cutoff', () => {
    expect(select({ candidates: [] })).toEqual({ ok: false, failure: 'required-context-unavailable', detail: 'no-contribution' });
    expect(select({ candidates: [valid('plan', 11)] })).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'no-contribution'
    });
  });

  it('selects nothing and records nothing for an optional request that matches no candidate', () => {
    const result = accepted(select({ policy: policy({ selectors: [optional('plan')] }), candidates: [] }));
    expect(result.sources).toEqual([]);
    expect(result.omissions).toEqual([]);
  });

  it.each([
    ['required', required('plan')],
    ['optional', optional('plan')]
  ])('refuses a %s request that matches two occurrences at the cutoff: the later one is not taken', (_label, entry) => {
    const candidates = [valid('plan', 1, {}, 'occ-1'), valid('plan', 2, {}, 'occ-2')];
    expect(select({ policy: policy({ selectors: [entry] }), candidates })).toEqual({
      ok: false,
      failure: 'invalid-source',
      detail: 'ambiguous-source'
    });
  });

  it('refuses a bound input that matches two occurrences', () => {
    const candidates = [valid('plan', 1, {}, 'occ-1'), valid('plan', 2, {}, 'occ-2')];
    const result = select({ policy: policy({ selectors: [] }), boundInputs: [{ bindingId: 'bind-plan', sourceNodePath: 'plan' }], candidates });
    expect(result).toEqual({ ok: false, failure: 'invalid-source', detail: 'ambiguous-source' });
  });

  it('takes the one occurrence at the cutoff when the second was accepted after it', () => {
    const result = accepted(select({ candidates: [valid('plan', 1, {}, 'occ-1'), valid('plan', 11, {}, 'occ-2')] }));
    expect(result.sources.map((source) => source.producer.occurrenceId)).toEqual(['occ-1']);
    expect(result.omissions).toEqual([{ producer: producer('plan', 'occ-2', 'att-plan'), request: null, reason: 'after-cutoff' }]);
  });

  it('refuses a required source whose coverage is unavailable', () => {
    expect(select({ candidates: [valid('plan', 1, { coverage: 'unavailable' })] })).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'coverage-unavailable'
    });
  });

  it('omits an optional source whose coverage is unavailable, naming the request', () => {
    const result = accepted(
      select({ policy: policy({ selectors: [optional('plan')] }), candidates: [valid('plan', 1, { coverage: 'unavailable' })] })
    );
    expect(result.sources).toEqual([]);
    expect(result.omissions).toEqual([
      { producer: producer('plan', 'occ-1', 'att-plan'), request: { kind: 'selector', id: 'sel-plan' }, reason: 'coverage-unavailable' }
    ]);
  });

  it('keeps partial coverage on the selected source', () => {
    const result = accepted(select({ candidates: [valid('plan', 1, { coverage: 'partial' })] }));
    expect(result.sources.map((source) => source.coverage)).toEqual(['partial']);
  });

  it.each<[string, Partial<SelectionInput>, string]>([
    ['the manifest budget', { manifestBytesBudget: 99 }, 'manifest-bytes'],
    ['the rendered budget', { renderedBytesBudget: 99 }, 'rendered-bytes']
  ])('refuses a required source that does not fit %s, and accepts it at the exact size', (_label, budget, detail) => {
    expect(select(budget)).toEqual({ ok: false, failure: 'capacity-exceeded', detail });
    expect(pathsOf(accepted(select({ manifestBytesBudget: 100, renderedBytesBudget: 100 })).sources)).toEqual(['plan']);
  });

  it('omits an optional source that does not fit, and every later optional request with it', () => {
    const costs = new Map([
      ['first', 100],
      ['large', 500],
      ['small', 10]
    ]);
    const result = accepted(
      select({
        policy: policy({ selectors: [optional('first', 0), optional('large', 1), optional('small', 2)] }),
        candidates: [valid('first'), valid('large'), valid('small')],
        manifestBytesBudget: 300,
        costOf: (source) => ({ manifestBytes: costs.get(source.producer.nodePath) ?? 0, renderedBytes: 1 })
      })
    );
    expect(pathsOf(result.sources)).toEqual(['first']);
    expect(result.omissions).toEqual([
      { producer: producer('large', 'occ-1', 'att-large'), request: { kind: 'selector', id: 'sel-large' }, reason: 'optional-capacity' },
      { producer: producer('small', 'occ-1', 'att-small'), request: { kind: 'selector', id: 'sel-small' }, reason: 'optional-capacity' }
    ]);
  });

  it('selects a source two requests name once, and keeps the first request', () => {
    const result = accepted(
      select({
        policy: policy({ selectors: [required('plan'), selector({ selectorId: 'sel-again', sourceNodePath: 'plan', required: false })] }),
        boundInputs: [{ bindingId: 'bind-plan', sourceNodePath: 'plan' }]
      })
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources.at(0)?.selectedBy).toEqual({ kind: 'binding', id: 'bind-plan' });
    expect(result.sources.at(0)?.required).toBe(true);
    expect(result.omissions).toEqual([]);
  });

  it('omits a candidate accepted after the cutoff and one no request names, each with its reason', () => {
    const result = accepted(select({ candidates: [valid('plan'), valid('late', 11), valid('other', 3)] }));
    expect(pathsOf(result.sources)).toEqual(['plan']);
    expect(result.omissions).toEqual([
      { producer: producer('late', 'occ-1', 'att-late'), request: null, reason: 'after-cutoff' },
      { producer: producer('other', 'occ-1', 'att-other'), request: null, reason: 'not-selected-by-policy' }
    ]);
  });

  it('takes a candidate accepted at the cutoff itself', () => {
    expect(pathsOf(accepted(select({ candidates: [valid('plan', 10)] })).sources)).toEqual(['plan']);
  });
});

describe('selectSources: an invalid contribution', () => {
  it('refuses when a request names it', () => {
    expect(select({ candidates: [invalidCandidate('plan')] })).toEqual({ ok: false, failure: 'invalid-source', detail: 'invalid-contribution' });
  });

  it('lists it as an omission by its accepting attempt when no request names it or it is after the cutoff', () => {
    const result = accepted(select({ candidates: [valid('plan'), invalidCandidate('other'), invalidCandidate('late', 11)] }));
    expect(result.omissions).toEqual([
      { producer: producer('late', 'occ-1', 'att-late'), request: null, reason: 'after-cutoff' },
      { producer: producer('other', 'occ-1', 'att-other'), request: null, reason: 'not-selected-by-policy' }
    ]);
  });
});

describe('selectSources: the order of requests', () => {
  it('takes bound inputs in the order given, then required selectors in policy order, then optional by priority and position', () => {
    const selectors = [
      optional('opt-late', 5),
      required('req-b'),
      optional('opt-first', 1),
      required('req-a'),
      optional('opt-second', 1)
    ];
    const boundInputs = [
      { bindingId: 'bind-z', sourceNodePath: 'bound-z' },
      { bindingId: 'bind-a', sourceNodePath: 'bound-a' }
    ];
    const candidates = ['opt-late', 'req-b', 'opt-first', 'req-a', 'opt-second', 'bound-z', 'bound-a'].map((path) => valid(path));
    const result = accepted(select({ policy: policy({ selectors }), boundInputs, candidates }));
    expect(pathsOf(result.sources)).toEqual(['bound-z', 'bound-a', 'req-b', 'req-a', 'opt-first', 'opt-second', 'opt-late']);
    expect(result.sources.map((source) => source.required)).toEqual([true, true, true, true, false, false, false]);
  });

  it('never lets optional context displace a bound input or a required source', () => {
    const result = accepted(
      select({
        policy: policy({ selectors: [optional('extra', 0), required('plan')] }),
        boundInputs: [{ bindingId: 'bind-input', sourceNodePath: 'input' }],
        candidates: [valid('extra'), valid('plan'), valid('input')],
        manifestBytesBudget: 200
      })
    );
    expect(pathsOf(result.sources)).toEqual(['input', 'plan']);
    expect(result.omissions.map((entry) => [entry.producer.nodePath, entry.reason])).toEqual([['extra', 'optional-capacity']]);
  });

  it('gives the same result whatever the order of the candidates', () => {
    const selectors = [required('plan'), optional('design', 1), optional('notes', 2)];
    const candidates = [valid('plan'), valid('design'), valid('notes'), valid('other'), valid('late', 11)];
    const forward = select({ policy: policy({ selectors }), candidates, manifestBytesBudget: 200 });
    const backward = select({ policy: policy({ selectors }), candidates: [...candidates].reverse(), manifestBytesBudget: 200 });
    expect(backward).toEqual(forward);
  });
});

describe('selectSources: the count limits', () => {
  it('selects 32 sources, refuses a required 33rd and omits an optional 33rd', () => {
    const paths = nodes(32, 'bound');
    const boundInputs = paths.map((path) => ({ bindingId: `bind-${path}`, sourceNodePath: path }));
    const candidates = [...paths, 'plan'].map((path) => valid(path));
    expect(pathsOf(accepted(select({ policy: policy({ selectors: [] }), boundInputs, candidates: candidates.slice(0, 32) })).sources)).toHaveLength(32);
    expect(select({ boundInputs, candidates })).toEqual({ ok: false, failure: 'capacity-exceeded', detail: 'source-count' });
    const result = accepted(select({ policy: policy({ selectors: [optional('plan')] }), boundInputs, candidates }));
    expect(result.sources).toHaveLength(32);
    expect(result.omissions.map((entry) => [entry.producer.nodePath, entry.reason])).toEqual([['plan', 'optional-capacity']]);
  });

  it('accepts 64 artifacts across the sources and refuses or omits the source that brings the 65th', () => {
    const artifacts = (count: number, prefix: string): SourceContribution['artifacts'] =>
      Array.from({ length: count }, (_unused, index) => artifactRef({ artifactId: `${prefix}-${index}` }));
    const first = valid('plan', 1, { artifacts: artifacts(32, 'p') });
    const atLimit = valid('design', 1, { artifacts: artifacts(32, 'd') });
    const over = valid('design', 1, { artifacts: artifacts(33, 'd') });
    const both = policy({ selectors: [required('plan'), required('design')] });
    expect(pathsOf(accepted(select({ policy: both, candidates: [first, atLimit] })).sources)).toEqual(['plan', 'design']);
    expect(select({ policy: both, candidates: [first, over] })).toEqual({ ok: false, failure: 'capacity-exceeded', detail: 'artifact-count' });
    const mixed = accepted(select({ policy: policy({ selectors: [required('plan'), optional('design')] }), candidates: [first, over] }));
    expect(pathsOf(mixed.sources)).toEqual(['plan']);
    expect(mixed.omissions.map((entry) => entry.reason)).toEqual(['optional-capacity']);
  });

  it.each(['outcomes', 'decisions', 'constraints', 'unresolvedIssues'] as const)(
    'accepts 32 %s across the sources and refuses the source that brings the 33rd',
    (collection) => {
      const entries = (count: number): string[] => Array.from({ length: count }, () => 'entry');
      const empty = { outcomes: [], decisions: [], constraints: [], unresolvedIssues: [] };
      const first = valid('plan', 1, { ...empty, [collection]: entries(16) });
      const both = policy({ selectors: [required('plan'), required('design')] });
      const atLimit = select({ policy: both, candidates: [first, valid('design', 1, { ...empty, [collection]: entries(16) })] });
      expect(pathsOf(accepted(atLimit).sources)).toEqual(['plan', 'design']);
      expect(select({ policy: both, candidates: [first, valid('design', 1, { ...empty, [collection]: entries(17) })] })).toEqual({
        ok: false,
        failure: 'capacity-exceeded',
        detail: 'entry-count'
      });
    }
  );
});

describe('selectSources: the omissions', () => {
  it('lists the capacity and coverage omissions in request order, then the rest by node path, occurrence and attempt', () => {
    const selectors = [required('plan'), optional('zeta', 0), optional('alpha', 1), optional('mid', 2)];
    const candidates = [
      valid('plan'),
      valid('zeta', 1, { coverage: 'unavailable' }),
      valid('alpha'),
      valid('mid'),
      valid('unnamed-b'),
      valid('late', 11, {}, 'occ-2'),
      valid('late', 12, {}, 'occ-1'),
      valid('unnamed-a')
    ];
    const result = accepted(select({ policy: policy({ selectors }), candidates, manifestBytesBudget: 150 }));
    expect(pathsOf(result.sources)).toEqual(['plan']);
    expect(result.omissions.map((entry) => [entry.producer.nodePath, entry.producer.occurrenceId, entry.reason, entry.request?.id ?? null])).toEqual([
      ['zeta', 'occ-1', 'coverage-unavailable', 'sel-zeta'],
      ['alpha', 'occ-1', 'optional-capacity', 'sel-alpha'],
      ['mid', 'occ-1', 'optional-capacity', 'sel-mid'],
      ['late', 'occ-1', 'after-cutoff', null],
      ['late', 'occ-2', 'after-cutoff', null],
      ['unnamed-a', 'occ-1', 'not-selected-by-policy', null],
      ['unnamed-b', 'occ-1', 'not-selected-by-policy', null]
    ]);
  });

  it('records one candidate as omitted once when two optional requests name it', () => {
    const selectors = [optional('plan', 0), selector({ selectorId: 'sel-again', sourceNodePath: 'plan', required: false, priority: 1 })];
    const result = accepted(select({ policy: policy({ selectors }), manifestBytesBudget: 50 }));
    expect(result.omissions).toEqual([
      { producer: producer('plan', 'occ-1', 'att-plan'), request: { kind: 'selector', id: 'sel-plan' }, reason: 'optional-capacity' }
    ]);
  });

  it('lists 32 omissions and counts the rest', () => {
    const exact = accepted(select({ candidates: [valid('plan'), ...nodes(32, 'other').map((path) => valid(path))] }));
    expect(exact.omissions).toHaveLength(32);
    expect(exact.omissionsUnlisted).toBe(0);
    const more = accepted(select({ candidates: [valid('plan'), ...nodes(40, 'other').map((path) => valid(path))] }));
    expect(more.omissions).toHaveLength(32);
    expect(more.omissionsUnlisted).toBe(8);
    expect(more.omissions.at(0)?.producer.nodePath).toBe('other-00');
    expect(more.omissions.at(31)?.producer.nodePath).toBe('other-31');
  });
});
