/**
 * FR-R4-F12 (FR-R4-102; contract PI2, PI3; SC-003; tests-and-gates T5) -- the prompt identity is a
 * content-free digest of the output contract and the task block, equal when those are equal and
 * different when either differs, and unaffected by everything a run varies.
 *
 * WHY IT EXISTS. A maintainer comparing two Runs could not tell whether they were asked under the
 * same output contract. The identity answers that without recording any prompt text: it covers the
 * contract text, the composition version and the task block as rendered, and nothing dynamic
 * (data-model section 3). Three properties are measured here, each over a counted set:
 *
 *   (a) at least 10 composed prompts, each composed twice with every excluded input varied by a
 *       seeded generator: 100% equal identities;
 *   (b) a single-character change to each covered part: 100% different identities;
 *   (c) the excluded inputs varied alone: 0% different identities.
 *
 * (d) is the pinned scaffold fingerprint (research R10). The digest covers the contract text and the
 * task block, not the lines `build()` lays around them. A change to that scaffold would change what
 * the model is told without changing the digest, so the layout is pinned by the SHA-256 of `build()`
 * for one fixed input, beside `PROMPT_COMPOSITION_VERSION`.
 *
 * THE PAIR COUNTS are printed, so a reader sees the denominators. Seeds are fixed and printed.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PromptBuilder, type PromptInputs } from '../../../src/runner/prompt-builder';
import {
  PROMPT_COMPOSITION_VERSION,
  RESUME_PROMPT_IDENTITY,
  promptContractDigest,
  readPromptIdentity,
  type PromptIdentity
} from '../../../src/runner/prompt-identity';
import { mulberry32, pick } from '../../fixtures/seeded-rng';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import type { ExecutionEnvelope } from '../../../src/contracts/run-request';

const SEED = 259_056;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * (d) The scaffold fingerprint. A red here means the lines `build()` lays around the contract text
 * and the task block changed: bump `PROMPT_COMPOSITION_VERSION` if anything outside the contract
 * text and the task block changed, then re-pin both values together.
 */
const PINNED_COMPOSITION_VERSION = 1;
const PINNED_SCAFFOLD_SHA256 = '6b9d7f69feebdd8e9c127cbfed69f475538e9af22ebb97dfcf12d8693cdf2274';

const CANONICAL_INPUT: PromptInputs = {
  phase: 'speckit-specify',
  phaseDef: {
    id: 'speckit-specify',
    name: 'Specify',
    version: 1,
    instruction: 'Write the specification.'
  } as PhaseDef,
  iteration: 2,
  iterationCap: 10,
  featureDescription: 'A canonical feature description.',
  featureDir: 'specs/001-canonical',
  carriedIssues: [{ tag: 'coverage', summary: 'one gap' }, { summary: 'a plain issue' }],
  phaseMessagePath: '.schegent/sessions/canonical/phase-message.env',
  previousPhaseMessage: { B: '2', A: '1' },
  continuationNote: 'Finish the turn.'
};

function phaseDef(parts: Partial<PhaseDef>): PhaseDef {
  return { id: 'p', name: 'P', ...parts } as PhaseDef;
}

interface BaseCase {
  readonly name: string;
  readonly kind: 'instruction' | 'skill' | 'none';
  readonly inputs: PromptInputs;
}

function base(phase: string, def: PhaseDef | undefined): PromptInputs {
  return {
    phase,
    ...(def === undefined ? {} : { phaseDef: def }),
    iteration: 1,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: null
  };
}

/** Ten composed prompts: instruction, skill and no-op Phases. */
const BASE_CASES: readonly BaseCase[] = [
  { name: 'instruction: specify', kind: 'instruction', inputs: base('speckit-specify', phaseDef({ instruction: 'Write the specification.' })) },
  { name: 'instruction: plan', kind: 'instruction', inputs: base('speckit-plan', phaseDef({ instruction: 'Plan it.' })) },
  { name: 'instruction: implement', kind: 'instruction', inputs: base('speckit-implement', phaseDef({ instruction: 'Implement every task.' })) },
  { name: 'instruction: multi-line', kind: 'instruction', inputs: base('custom', phaseDef({ instruction: 'Line one.\nLine two.\n\nLine four.' })) },
  { name: 'skill: plan', kind: 'skill', inputs: base('speckit-plan', phaseDef({ skill: 'speckit-plan' })) },
  { name: 'skill: tasks', kind: 'skill', inputs: base('speckit-tasks', phaseDef({ skill: 'speckit-tasks' })) },
  { name: 'skill: padded', kind: 'skill', inputs: base('custom', phaseDef({ skill: '  speckit-analyze  ' })) },
  { name: 'skill: with blank instruction', kind: 'skill', inputs: base('custom', phaseDef({ instruction: '   ', skill: 'speckit-checklist' })) },
  { name: 'no-op: no definition', kind: 'none', inputs: base('speckit-specify', undefined) },
  { name: 'no-op: blank instruction and skill', kind: 'none', inputs: base('custom', phaseDef({ instruction: ' ', skill: '' })) }
];

const PHASE_IDS = ['speckit-specify', 'speckit-plan', 'custom-a', 'finalize', 'x'] as const;
const WORDS = ['alpha', 'beta', 'specs/009-x', '/Users/someone/work', 'C:\\Users\\someone', 'token=abc', '日本語', '[SCHEGENT_STATUS: CLEAR]'];

function words(rng: () => number, count: number): string {
  return Array.from({ length: count }, () => pick(rng, WORDS)).join(' ');
}

function envelopeFor(rng: () => number): ExecutionEnvelope {
  return {
    pipeline: { id: 'e', name: 'E', phases: [{ id: 'c', name: 'C', version: 1, instruction: 'x' }] },
    inputs: [{ portId: 'brief', type: 'text', value: words(rng, 3) }],
    supplemental: [{ kind: 'text', value: words(rng, 2) }],
    outputs: [{ portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: false }],
    ...(rng() < 0.5 ? { instructions: words(rng, 4) } : {}),
    frozenAt: 1_700_000_000_000 + Math.floor(rng() * 1000)
  };
}

/** `inputs` with every excluded input replaced by a seeded value (data-model section 3). */
function varyExcluded(rng: () => number, inputs: PromptInputs): PromptInputs {
  const def = inputs.phaseDef;
  return {
    ...inputs,
    phase: pick(rng, PHASE_IDS),
    iteration: 1 + Math.floor(rng() * 9),
    iterationCap: 5 + Math.floor(rng() * 20),
    featureDescription: words(rng, 5),
    featureDir: rng() < 0.3 ? null : `specs/${String(Math.floor(rng() * 999)).padStart(3, '0')}-${pick(rng, WORDS)}`,
    ...(rng() < 0.5 ? { carriedIssues: [{ tag: 'coverage', summary: words(rng, 3) }, { summary: words(rng, 2) }] } : {}),
    phaseMessagePath: rng() < 0.5 ? `.schegent/sessions/${words(rng, 1)}/phase-message.env` : null,
    previousPhaseMessage: rng() < 0.5 ? { [pick(rng, ['A', 'B', 'C'])]: words(rng, 2) } : null,
    ...(rng() < 0.5 ? { envelope: envelopeFor(rng) } : {}),
    ...(rng() < 0.5 ? { continuationNote: words(rng, 4) } : {}),
    ...(def === undefined
      ? {}
      : {
          phaseDef: {
            ...def,
            id: words(rng, 1),
            name: words(rng, 2),
            version: Math.floor(rng() * 50),
            promptVersion: words(rng, 1),
            evidencePolicy: pick(rng, ['required', 'best-effort', 'none'] as const),
            model: words(rng, 1)
          } as PhaseDef
        })
  };
}

function identityOf(builder: PromptBuilder, inputs: PromptInputs): PromptIdentity {
  return builder.compose(inputs).identity;
}

describe('FR-R4-102 -- (a) equal covered inputs give equal identities, whatever else varies', () => {
  const builder = new PromptBuilder();

  it('composes at least 10 prompts, across instruction, skill and no-op Phases', () => {
    expect(BASE_CASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(BASE_CASES.map((testCase) => testCase.kind))).toEqual(new Set(['instruction', 'skill', 'none']));
  });

  it('is 100% equal over every pair, each composed twice with every excluded input varied', () => {
    const rng = mulberry32(SEED);
    let pairs = 0;
    const unequal: string[] = [];
    for (const testCase of BASE_CASES) {
      for (let round = 0; round < 20; round++) {
        const first = identityOf(builder, varyExcluded(rng, testCase.inputs));
        const second = identityOf(builder, varyExcluded(rng, testCase.inputs));
        pairs += 1;
        if (JSON.stringify(first) !== JSON.stringify(second)) unequal.push(`${testCase.name} round ${round}`);
      }
    }
    console.log(`[FR-R4-102 T5] (a) ${pairs} pairs, ${pairs - unequal.length} equal, seed ${SEED}`);

    expect(pairs).toBeGreaterThanOrEqual(200);
    expect(unequal, `seed ${SEED}`).toEqual([]);
  });

  it('records a contract-scope identity with the pinned version and a sha256 digest', () => {
    for (const testCase of BASE_CASES) {
      const identity = identityOf(builder, testCase.inputs);

      expect(identity).toEqual({
        scope: 'contract',
        compositionVersion: PROMPT_COMPOSITION_VERSION,
        digest: expect.stringMatching(DIGEST_PATTERN)
      });
    }
  });

  it('gives different identities to Phases whose task blocks differ (the identity is not constant)', () => {
    const digests = BASE_CASES.map((testCase) => {
      const identity = identityOf(builder, testCase.inputs);
      return identity.scope === 'contract' ? identity.digest : 'resume';
    });
    // `no-op` twice and `skill: padded` / trimmed variants may legitimately collide on the text;
    // the distinct task texts must produce distinct digests.
    const distinctTexts = new Set(
      BASE_CASES.map((testCase) => JSON.stringify(builderTask(testCase.inputs)))
    );
    expect(new Set(digests).size).toBe(distinctTexts.size);
    expect(distinctTexts.size).toBeGreaterThanOrEqual(8);
  });
});

/** The task block as `compose` renders it, read back from the composed text between TASK: and the brief. */
function builderTask(inputs: PromptInputs): string {
  const text = new PromptBuilder().build(inputs);
  const start = text.indexOf('\nTASK:\n') + '\nTASK:\n'.length;
  const end = text.indexOf('\nFEATURE DESCRIPTION:\n');
  return text.slice(start, end);
}

describe('FR-R4-102 -- (b) a single-character change to a covered part changes the identity', () => {
  const parts = {
    compositionVersion: PROMPT_COMPOSITION_VERSION,
    contractText: 'contract text',
    taskKind: 'instruction' as const,
    taskText: 'task text'
  };

  it('promptContractDigest differs for a one-character change to each covered part', () => {
    const original = promptContractDigest(parts);
    const changed = [
      promptContractDigest({ ...parts, contractText: 'contract texu' }),
      promptContractDigest({ ...parts, taskText: 'task texu' }),
      promptContractDigest({ ...parts, taskKind: 'skill' }),
      promptContractDigest({ ...parts, compositionVersion: parts.compositionVersion + 1 })
    ];

    expect(original).toMatch(DIGEST_PATTERN);
    for (const digest of changed) {
      expect(digest).toMatch(DIGEST_PATTERN);
      expect(digest).not.toBe(original);
    }
    expect(new Set([original, ...changed]).size).toBe(5);
    console.log(`[FR-R4-102 T5] (b) digest parts: ${changed.length} single-part changes, ${changed.length} different`);
  });

  it('is deterministic and unambiguous: the join cannot be forged by moving text between parts', () => {
    expect(promptContractDigest(parts)).toBe(promptContractDigest({ ...parts }));
    const a = promptContractDigest({ ...parts, contractText: 'ab', taskText: 'c' });
    const b = promptContractDigest({ ...parts, contractText: 'a', taskText: 'bc' });
    expect(a).not.toBe(b);
  });

  it('compose differs for a one-character change to the instruction or the skill reference', () => {
    const builder = new PromptBuilder();
    let changes = 0;
    let different = 0;
    for (const testCase of BASE_CASES.filter((candidate) => candidate.kind !== 'none')) {
      const def = testCase.inputs.phaseDef as PhaseDef;
      const edited: PhaseDef =
        testCase.kind === 'instruction'
          ? ({ ...def, instruction: `${def.instruction ?? ''}!` } as PhaseDef)
          : ({ ...def, skill: `${(def.skill ?? '').trim()}!` } as PhaseDef);
      changes += 1;
      if (JSON.stringify(identityOf(builder, testCase.inputs)) !== JSON.stringify(identityOf(builder, { ...testCase.inputs, phaseDef: edited }))) {
        different += 1;
      }
    }
    console.log(`[FR-R4-102 T5] (b) ${changes} compose changes, ${different} different`);

    expect(changes).toBeGreaterThanOrEqual(8);
    expect(different).toBe(changes);
  });
});

describe('FR-R4-102 -- (c) excluded inputs varied alone change nothing', () => {
  const builder = new PromptBuilder();

  const VARIATIONS: ReadonlyArray<{ name: string; vary: (inputs: PromptInputs, rng: () => number) => PromptInputs }> = [
    { name: 'iteration', vary: (inputs) => ({ ...inputs, iteration: inputs.iteration + 3 }) },
    { name: 'iteration cap', vary: (inputs) => ({ ...inputs, iterationCap: inputs.iterationCap + 7 }) },
    { name: 'phase id', vary: (inputs) => ({ ...inputs, phase: `${inputs.phase}-other` }) },
    { name: 'feature description', vary: (inputs, rng) => ({ ...inputs, featureDescription: words(rng, 6) }) },
    { name: 'feature dir', vary: (inputs) => ({ ...inputs, featureDir: 'specs/777-other' }) },
    { name: 'carried issues', vary: (inputs) => ({ ...inputs, carriedIssues: ['an issue'] }) },
    { name: 'phase message path', vary: (inputs) => ({ ...inputs, phaseMessagePath: '.schegent/x/phase-message.env' }) },
    { name: 'previous phase message', vary: (inputs) => ({ ...inputs, previousPhaseMessage: { K: 'v' } }) },
    { name: 'envelope', vary: (inputs, rng) => ({ ...inputs, envelope: envelopeFor(rng) }) },
    { name: 'continuation note', vary: (inputs) => ({ ...inputs, continuationNote: 'resume' }) },
    {
      name: 'PhaseDef.promptVersion and other metadata',
      vary: (inputs) =>
        inputs.phaseDef === undefined
          ? inputs
          : { ...inputs, phaseDef: { ...inputs.phaseDef, promptVersion: 'custom-v9', name: 'Renamed', version: 99 } as PhaseDef }
    }
  ];

  it('is 0% different over every (case, variation) pair', () => {
    const rng = mulberry32(SEED + 1);
    let pairs = 0;
    const differing: string[] = [];
    for (const testCase of BASE_CASES) {
      const original = JSON.stringify(identityOf(builder, testCase.inputs));
      for (const variation of VARIATIONS) {
        pairs += 1;
        const varied = JSON.stringify(identityOf(builder, variation.vary(testCase.inputs, rng)));
        if (varied !== original) differing.push(`${testCase.name} / ${variation.name}`);
      }
    }
    console.log(`[FR-R4-102 T5] (c) ${pairs} pairs, ${differing.length} different, seed ${SEED + 1}`);

    expect(pairs).toBe(BASE_CASES.length * VARIATIONS.length);
    expect(differing, `seed ${SEED + 1}`).toEqual([]);
  });

  it('feeds the feature description into the text, so the 0% above is not an identical-prompt artifact', () => {
    const text = builder.build({ ...CANONICAL_INPUT, featureDescription: 'MARKER-ONE' });
    const other = builder.build({ ...CANONICAL_INPUT, featureDescription: 'MARKER-TWO' });

    expect(text).not.toBe(other);
    expect(text).toContain('MARKER-ONE');
  });
});

describe('FR-R4-102 -- (d) the scaffold fingerprint is pinned with the composition version', () => {
  it('pins the composition version', () => {
    expect(PROMPT_COMPOSITION_VERSION).toBe(PINNED_COMPOSITION_VERSION);
  });

  it('pins the SHA-256 of build() for one canonical input', () => {
    const text = new PromptBuilder().build(CANONICAL_INPUT);

    expect(
      createHash('sha256').update(text).digest('hex'),
      'The prompt scaffold changed. If anything outside the contract text and the task block changed, ' +
        'bump PROMPT_COMPOSITION_VERSION; then re-pin both values in this file together.'
    ).toBe(PINNED_SCAFFOLD_SHA256);
  });
});

describe('FR-R4-102 -- (e) build and compose agree', () => {
  it('build(x) === compose(x).text for every case, canonical and generated', () => {
    const builder = new PromptBuilder();
    const rng = mulberry32(SEED + 2);
    const inputs = [CANONICAL_INPUT, ...BASE_CASES.map((testCase) => testCase.inputs), ...BASE_CASES.map((testCase) => varyExcluded(rng, testCase.inputs))];

    for (const candidate of inputs) {
      expect(builder.build(candidate)).toBe(builder.compose(candidate).text);
    }
    expect(inputs.length).toBeGreaterThanOrEqual(21);
  });
});

describe('FR-R4-102 -- (f) readPromptIdentity accepts only the two shapes', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const GOOD: PromptIdentity = { scope: 'contract', compositionVersion: 1, digest: DIGEST };

  it('reads a contract identity and a resume identity as recorded', () => {
    expect(readPromptIdentity({ promptIdentity: GOOD })).toEqual({ recorded: true, identity: GOOD });
    expect(readPromptIdentity({ promptIdentity: { scope: 'resume' } })).toEqual({
      recorded: true,
      identity: { scope: 'resume' }
    });
    expect(readPromptIdentity({ promptIdentity: RESUME_PROMPT_IDENTITY })).toEqual({
      recorded: true,
      identity: { scope: 'resume' }
    });
  });

  it('reads the identity a composed prompt produced as recorded', () => {
    const { identity } = new PromptBuilder().compose(CANONICAL_INPUT);

    expect(readPromptIdentity({ promptIdentity: identity })).toEqual({ recorded: true, identity });
  });

  it('reads absence and every other shape as not recorded', () => {
    const notRecorded = [
      {},
      { promptIdentity: undefined },
      { promptIdentity: null },
      { promptIdentity: 'sha256:abc' },
      { promptIdentity: [] },
      { promptIdentity: { ...GOOD, extra: 1 } },
      { promptIdentity: { scope: 'resume', digest: DIGEST } },
      { promptIdentity: { scope: 'resume', compositionVersion: 1 } },
      { promptIdentity: { scope: 'contract', compositionVersion: 1 } },
      { promptIdentity: { scope: 'contract', digest: DIGEST } },
      { promptIdentity: { ...GOOD, compositionVersion: 0 } },
      { promptIdentity: { ...GOOD, compositionVersion: -1 } },
      { promptIdentity: { ...GOOD, compositionVersion: 1.5 } },
      { promptIdentity: { ...GOOD, compositionVersion: '1' } },
      { promptIdentity: { ...GOOD, compositionVersion: Number.MAX_SAFE_INTEGER + 2 } },
      { promptIdentity: { ...GOOD, digest: `sha256:${'A'.repeat(64)}` } },
      { promptIdentity: { ...GOOD, digest: `sha256:${'a'.repeat(63)}` } },
      { promptIdentity: { ...GOOD, digest: `sha256:${'a'.repeat(65)}` } },
      { promptIdentity: { ...GOOD, digest: 'a'.repeat(64) } },
      { promptIdentity: { ...GOOD, digest: 7 } },
      { promptIdentity: { scope: 'other', compositionVersion: 1, digest: DIGEST } },
      { promptIdentity: { scope: 'other' } },
      { promptIdentity: { compositionVersion: 1, digest: DIGEST } }
    ];

    for (const payload of notRecorded) {
      expect(readPromptIdentity(payload as Record<string, unknown>), JSON.stringify(payload)).toEqual({
        recorded: false
      });
    }
    expect(notRecorded.length).toBeGreaterThanOrEqual(20);
  });

  it('freezes the resume marker', () => {
    expect(Object.isFrozen(RESUME_PROMPT_IDENTITY)).toBe(true);
    expect(RESUME_PROMPT_IDENTITY).toEqual({ scope: 'resume' });
  });
});
