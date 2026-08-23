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
