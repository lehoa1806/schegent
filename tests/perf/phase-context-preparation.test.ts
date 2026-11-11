// FR-R6-F15 T042 (NFR-005, F15-AC-10) -- preparing one handoff with a maximum manifest.
//
// One sample is one `prepareHandoff` call: the policy, the identity and 256 candidates are
// validated, 32 sources are selected at one cutoff, the manifest is built, serialized and
// digested, and the context is rendered. The input is built before the clock starts, and every
// sample has its own text, so a sample holds the work a caller of preparation waits for and
// nothing else. Nothing is read from a disk or a network: the bound is for selection, manifest
// and rendering in memory, as the spec's delivery scope says.
//
// The reference handoff is the largest one the limits admit: 256 candidates (the candidate
// limit), 32 selectors of which one is required, 32 selected sources (the source limit) with
// four entries each, so each of the four collections holds its 32 entries, and a rendered
// context within 2 KiB of the 32 KiB bound. The 224 candidates no selector names are omissions.
// 20 warm-up and 200 measured samples, the F03 floor. Lives in the perf tier, not beside the
// acceptance test, per FR-R3-042.

import { describe, expect, it } from 'vitest';

import { PHASE_CONTEXT_LIMITS, type ContributionCandidate } from '../../src/contracts/phase-context/context-policy';
import { prepareHandoff, type PrepareInput } from '../../src/services/phase-context/index';
import { candidate, identityFor, policy, profile, selector, textOfBytes } from '../fixtures/phase-context/builders';

const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 200;
const P95_BUDGET_MS = 250;
const P50_RANK = 0.5;
const P95_RANK = 0.95;
const CANDIDATES = PHASE_CONTEXT_LIMITS.candidatesMax;
const SELECTED = PHASE_CONTEXT_LIMITS.sourceContributionsMax;
const ENTRY_BYTES = 200;
const RENDERED_FLOOR_BYTES = PHASE_CONTEXT_LIMITS.renderedContextBytesMax - 2 * 1_024;

function percentile(samples: readonly number[], rank: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
  return sorted.at(index) ?? Number.POSITIVE_INFINITY;
}

function nodeOf(index: number): string {
  return `node-${String(index).padStart(3, '0')}`;
}

/** An entry of `ENTRY_BYTES` bytes that differs between samples, sources and collections. */
function entry(sample: number, index: number, collection: string): string {
  const label = `${collection} ${String(sample)}/${String(index)} `;
  return label + textOfBytes(ENTRY_BYTES - label.length, 'x');
}

/** The reference handoff of one sample. */
function referenceInput(sample: number): PrepareInput {
  const candidates: ContributionCandidate[] = Array.from({ length: CANDIDATES }, (_unused, index) =>
    candidate(nodeOf(index), index + 1, {
      outcomes: [entry(sample, index, 'outcome')],
      decisions: [entry(sample, index, 'decision')],
      constraints: [entry(sample, index, 'constraint')],
      unresolvedIssues: [entry(sample, index, 'issue')]
    })
  );
  const selectors = Array.from({ length: SELECTED }, (_unused, index) =>
    selector({ selectorId: `sel-${String(index)}`, sourceNodePath: nodeOf(index), required: index === 0, priority: index })
  );
  return {
    policy: policy({ selectors }),
    // The identity names the attempts the handoff may carry: the 32 the selectors ask for.
    identity: identityFor(candidates.slice(0, SELECTED)),
    cutoffSequence: CANDIDATES,
    candidates,
    boundInputs: [],
    targetInstructions: `Implement the plan of sample ${String(sample)}.`,
    profile: profile()
  };
}

describe('FR-R6-F15 phase-context preparation latency (NFR-005)', () => {
  it('prepares one handoff with a maximum manifest in at most 250 ms at p95', () => {
    const samples: number[] = [];
    let selected = 0;
    let omitted = 0;
    let renderedBytesMin = Number.POSITIVE_INFINITY;
    let manifestBytesMin = Number.POSITIVE_INFINITY;

    for (let sample = 0; sample < WARMUP_SAMPLES + MEASURED_SAMPLES; sample += 1) {
      const input = referenceInput(sample);
      const started = performance.now();
      const result = prepareHandoff(input);
      const elapsed = performance.now() - started;
      if (result.kind !== 'prepared') throw new Error(`sample ${String(sample)} not prepared: ${JSON.stringify(result)}`);
      if (sample < WARMUP_SAMPLES) continue;
      samples.push(elapsed);
      selected += result.manifest.sources.length;
      omitted += result.manifest.omissions.length + result.manifest.omissionsUnlisted;
      renderedBytesMin = Math.min(renderedBytesMin, result.rendered.bytes);
      manifestBytesMin = Math.min(manifestBytesMin, Buffer.byteLength(result.serialized, 'utf8'));
    }

    const p50 = percentile(samples, P50_RANK);
    const p95 = percentile(samples, P95_RANK);
    console.info(JSON.stringify({ samples: samples.length, candidates: CANDIDATES, renderedBytesMin, manifestBytesMin, p50Ms: p50, p95Ms: p95 }));
    expect(samples).toHaveLength(MEASURED_SAMPLES);
    // Every sample did the whole of the work: all 32 sources selected, every other candidate
    // accounted for as an omission, and a rendered context at the top of its bound.
    expect(selected).toBe(MEASURED_SAMPLES * SELECTED);
    expect(omitted).toBe(MEASURED_SAMPLES * (CANDIDATES - SELECTED));
    expect(renderedBytesMin).toBeGreaterThanOrEqual(RENDERED_FLOOR_BYTES);
    expect(renderedBytesMin).toBeLessThanOrEqual(PHASE_CONTEXT_LIMITS.renderedContextBytesMax);
    expect(manifestBytesMin).toBeLessThanOrEqual(PHASE_CONTEXT_LIMITS.manifestBytesMax);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
