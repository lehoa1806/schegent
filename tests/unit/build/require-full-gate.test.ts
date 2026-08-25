import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Loaded dynamically, and typed by inference through the loader, exactly as the
 * other tests that reach into `scripts/` do. A static import of an ES module
 * from this CommonJS test program is TS1479, and annotating the module's type
 * directly is TS7016 -- inference through the loader is what
 * `typecheck:tests` accepts.
 */
async function loadGate() {
  return import('../../../scripts/require-full-gate.mjs');
}

let gate: Awaited<ReturnType<typeof loadGate>>;

beforeAll(async () => {
  gate = await loadGate();
});

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (over: Record<string, unknown>) => ({
  id: 1,
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://example.invalid/run',
  ...over
});

describe('the release requires a green full gate at the exact commit', () => {
  it('accepts a completed successful run on this commit', () => {
    const verdict = gate.decideFullGate({ workflow_runs: [run({})] }, SHA);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain(SHA);
  });

  it('refuses when no run exists for the commit at all', () => {
    const verdict = gate.decideFullGate({ workflow_runs: [] }, SHA);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(gate.FULL_GATE_WORKFLOW);
    expect(verdict.message).toContain(SHA);
    // The message must say what to do, not only that something is missing.
    expect(verdict.message).toContain('Dispatch it on this exact commit');
  });

  it('refuses a success on a DIFFERENT commit', () => {
    // The exact confusion this gate exists to remove: a green gate somewhere in
    // history is not a green gate here.
    const verdict = gate.decideFullGate({ workflow_runs: [run({ head_sha: OTHER })] }, SHA);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a run still in progress', () => {
    const verdict = gate.decideFullGate(
      { workflow_runs: [run({ status: 'in_progress', conclusion: null })] },
      SHA
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('in_progress/none');
  });

  it('refuses a failed or cancelled run', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
      expect(gate.decideFullGate({ workflow_runs: [run({ conclusion })] }, SHA).ok).toBe(false);
    }
  });

  it('accepts when one green run sits alongside failures on the same commit', () => {
    // A re-run after a flake is legitimate evidence; requiring that NO run ever
    // failed would make the gate unusable.
    const verdict = gate.decideFullGate(
      { workflow_runs: [run({ id: 1, conclusion: 'failure' }), run({ id: 2 })] },
      SHA
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('run 2');
  });

  it('refuses a malformed or empty payload rather than passing it', () => {
    // Fail closed. An unreadable answer is not a green gate.
    for (const payload of [undefined, null, {}, { workflow_runs: null }, 'nope']) {
      expect(gate.decideFullGate(payload, SHA).ok).toBe(false);
    }
  });
});

/**
 * FR-R3-087 — the per-job stage.
 *
 * The defect this closes is not hypothetical about GitHub's semantics: a run is
 * `success` when every job that RAN succeeded, so a job removed by an `if:`
 * leaves the run green and the release binding satisfied. Stage 1 cannot see
 * that, because the run summary is exactly what it reads.
 *
 * Every case below is a pure decision over a payload, so the gate is exercised
 * without a network and without cutting a release. A release gate that could
 * only be exercised by cutting a release is a gate nobody exercises.
 */
describe('FR-R3-087 — decideJobCoverage', () => {
  const job = (
    name: string,
    over: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    ...over
  });

  /** Every required job, all green — the baseline the mutations depart from. */
  const allGreen = (): { jobs: Record<string, unknown>[]; total_count: number } => {
    const jobs = (gate.REQUIRED_JOB_NAMES as readonly string[]).map((name) => job(name));
    return { jobs, total_count: jobs.length };
  };

  it('accepts a run whose every required job completed successfully', () => {
    const verdict = gate.decideJobCoverage(allGreen());
    expect(verdict.ok).toBe(true);
  });

  it('REFUSES a run-level success whose named job was SKIPPED, and names that job', () => {
    // The whole item, in one assertion.
    const payload = allGreen();
    const target = 'perf budgets';
    payload.jobs = payload.jobs.map((entry) =>
      entry.name === target ? { ...entry, conclusion: 'skipped' } : entry
    );
    const verdict = gate.decideJobCoverage(payload);
    expect(verdict.ok).toBe(false);
    expect(verdict.skipped).toEqual([target]);
    expect(verdict.message).toContain(target);
    expect(verdict.message).toContain('did not run');
  });

  it('NON-VACUITY: the same payload with that job successful PASSES', () => {
    // Without this the refusal above could be an artefact of the fixture rather
    // than of the skip, and "the gate stayed red" would be the same observation
    // whether the gate works or the probe is wrong.
    expect(gate.decideJobCoverage(allGreen()).ok).toBe(true);
  });

  it('distinguishes an ABSENT job from a job that ran and FAILED', () => {
    const absentPayload = allGreen();
    absentPayload.jobs = absentPayload.jobs.filter((entry) => entry.name !== 'lint');
    const absent = gate.decideJobCoverage(absentPayload);

    const failedPayload = allGreen();
    failedPayload.jobs = failedPayload.jobs.map((entry) =>
      entry.name === 'lint' ? { ...entry, conclusion: 'failure' } : entry
    );
    const failed = gate.decideJobCoverage(failedPayload);

    expect(absent.ok).toBe(false);
    expect(failed.ok).toBe(false);
    expect(absent.missing).toEqual(['lint']);
    expect(absent.failed).toEqual([]);
    expect(failed.failed).toEqual(['lint']);
    expect(failed.missing).toEqual([]);
    // An absent check and a red check are different findings, and the operator
    // reading the refusal must be able to tell which they have.
    expect(absent.message).not.toBe(failed.message);
    expect(absent.message).toContain('absent from the run entirely');
    expect(failed.message).toContain('failed');
  });

  it('treats cancelled and not-yet-completed jobs as did-not-run, not as failures', () => {
    for (const over of [{ conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }]) {
      const payload = allGreen();
      payload.jobs = payload.jobs.map((entry) =>
        entry.name === 'build' ? { ...entry, ...over } : entry
      );
      const verdict = gate.decideJobCoverage(payload);
      expect(verdict.ok).toBe(false);
      expect(verdict.skipped).toEqual(['build']);
      expect(verdict.failed).toEqual([]);
    }
  });

  it('keeps the three buckets disjoint', () => {
    const payload = allGreen();
    payload.jobs = payload.jobs
      .filter((entry) => entry.name !== 'lint')
      .map((entry) => {
        if (entry.name === 'build') return { ...entry, conclusion: 'failure' };
        if (entry.name === 'perf budgets') return { ...entry, conclusion: 'skipped' };
        return entry;
      });
    const verdict = gate.decideJobCoverage(payload);
    const all = [
      ...(verdict.missing ?? []),
      ...(verdict.failed ?? []),
      ...(verdict.skipped ?? [])
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(verdict.message).toContain('lint');
    expect(verdict.message).toContain('build');
    expect(verdict.message).toContain('perf budgets');
  });

  it('refuses a malformed or empty jobs payload rather than passing it', () => {
    for (const payload of [undefined, null, {}, { jobs: null }, 'nope', { jobs: [] }]) {
      expect(gate.decideJobCoverage(payload).ok).toBe(false);
    }
  });

  it('ignores jobs the binding does not name, so an added optional job cannot break a release', () => {
    const payload = allGreen();
    payload.jobs = [
      ...payload.jobs,
      job('upload something', { conclusion: 'failure' }),
      job('notify', { conclusion: 'skipped' })
    ];
    expect(gate.decideJobCoverage(payload).ok).toBe(true);
  });

  it('stage 1 still returns the run id stage 2 must query, and still refuses another commit', () => {
    // The exact-SHA behaviour is unchanged by this story: a green run on a
    // different commit is still not evidence for this one.
    const green = gate.decideFullGate({ workflow_runs: [run({ id: 77 })] }, SHA);
    expect(green.ok).toBe(true);
    expect(green.runId).toBe(77);

    const otherCommit = gate.decideFullGate(
      { workflow_runs: [run({ id: 77, head_sha: 'b'.repeat(40) })] },
      SHA
    );
    expect(otherCommit.ok).toBe(false);
  });
});
