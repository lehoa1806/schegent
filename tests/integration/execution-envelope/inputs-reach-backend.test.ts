// FR-R3-001 (T270) — what the operator declared arrives at the backend.
//
// This is the acceptance scenario stated as a fact about the CLI boundary
// rather than about the prompt builder. `prompt-builder-envelope.test.ts`
// already proves the sections render; that test would have passed unchanged
// throughout the entire period feature 087 was dropping four of five fields,
// because nothing between the validator and the subprocess was carrying them.
// So the observation point here is the `InvocationRequest` the CLI runner is
// handed, reached through the real validator, queue, controller, driver and
// phase runner.
//
// The parity assertion the acceptance criteria ask for — "the prompt is
// derivable from the envelope alone" — is made here as an equality against an
// independently built prompt: same envelope, deliberately different phase,
// iteration, feature directory and brief. If any seam between validation and the
// CLI re-derived, re-ordered, truncated or re-resolved the request, the two
// tails differ. It is not circular: the claim under test is not that the builder
// renders correctly, it is that nothing downstream of it altered what it
// rendered.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import {
  BRIEF,
  INSTRUCTIONS,
  REPORT_TARGET,
  SPEC_PATH,
  SUMMARY_TARGET,
  SUPPLEMENTAL_FILE,
  SUPPLEMENTAL_TEXT,
  SUPPLEMENTAL_URL,
  driveEnvelopeRun,
  type EnvelopeHarness
} from './envelope-harness';

let workspaceRoot: string;
let harness: EnvelopeHarness;

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-envelope-inputs-'));
  harness = await driveEnvelopeRun(workspaceRoot);
}, 30_000);

afterAll(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The envelope-derived tail of a prompt, from the first section header on. */
function envelopeTail(prompt: string): string {
  const start = prompt.indexOf('REQUEST INPUTS:');
  expect(start, 'the prompt carries no envelope sections at all').toBeGreaterThan(-1);
  return prompt.slice(start);
}

describe('declared inputs reach the backend (FR-R3-001)', () => {
  it('reaches the CLI boundary at all, so the assertions below are not vacuous', () => {
    // Two invocations, not three: `done` is the drive loop's terminal marker
    // (`run-driver.ts:313`) and is never invoked. A run that failed after the
    // first phase would leave one invocation, and every content assertion below
    // would still pass on that one — so the count is asserted, not just the
    // content.
    expect(harness.invocations.map((request) => request.phase)).toEqual(['compose', 'review']);
    expect(harness.finishedRun().currentPhase).toBe('done');
  });

  it('names every bound contract input, by port and by value', () => {
    const prompt = harness.firstPrompt();

    expect(prompt).toContain('REQUEST INPUTS:');
    expect(prompt).toContain(`- brief (text): ${BRIEF}`);
    expect(prompt).toContain(`- spec (local-file): ${SPEC_PATH}`);
  });

  it('carries every supplemental entry, in the envelope\'s order', () => {
    const prompt = harness.firstPrompt();

    expect(prompt).toContain('SUPPLEMENTAL CONTEXT:');
    // Position, not just presence: the documented order is the operator's
    // composition order, frozen. Asserting `toContain` three times would pass on
    // a renderer that sorted them.
    const positions = [SUPPLEMENTAL_FILE, SUPPLEMENTAL_URL, SUPPLEMENTAL_TEXT].map((value) =>
      prompt.indexOf(value)
    );
    expect(positions.every((at) => at > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('states both declared output targets before the backend runs', () => {
    const prompt = harness.firstPrompt();

    expect(prompt).toContain('DECLARED OUTPUT TARGETS:');
    expect(prompt).toContain(`- report (markdown) -> ${REPORT_TARGET}`);
    expect(prompt).toContain(`- summary (file) -> ${SUMMARY_TARGET}`);
  });

  it('carries the free-text instructions as request content, after the output contract', () => {
    const prompt = harness.firstPrompt();

    expect(prompt).toContain('OPERATOR INSTRUCTIONS:');
    expect(prompt).toContain(INSTRUCTIONS);
    // Separation is positional and stated: Schegent's contract is declared
    // first, in Schegent's words, and the operator's request follows it under a
    // heading that says whose words it is.
    expect(prompt.indexOf('OUTPUT CONTRACT:')).toBeLessThan(prompt.indexOf('OPERATOR INSTRUCTIONS:'));
    expect(prompt.indexOf(INSTRUCTIONS)).toBeGreaterThan(prompt.indexOf('OPERATOR INSTRUCTIONS:'));
  });

  it('carries the same request into every phase, not just the first', () => {
    // The envelope is the Run's, not the first invocation's. A seam that read it
    // once at start-up and dropped it afterwards would satisfy every assertion
    // above and still leave the later phases working from the brief alone.
    const tails = harness.invocations.map((request) => envelopeTail(request.prompt));

    expect(tails).toHaveLength(2);
    expect(new Set(tails).size).toBe(1);
  });

  it('delivers a prompt derivable from the envelope alone', () => {
    const independent = new PromptBuilder().build({
      // Deliberately unrelated to the run under test on every non-envelope axis.
      phase: 'speckit-plan',
      iteration: 4,
      iterationCap: 9,
      featureDescription: 'an entirely different brief',
      featureDir: 'specs/999-unrelated',
      envelope: harness.envelope
    });

    expect(envelopeTail(harness.firstPrompt())).toBe(envelopeTail(independent));
  });
});
