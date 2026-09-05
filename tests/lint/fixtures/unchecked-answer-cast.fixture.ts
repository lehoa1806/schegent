// Feature 202 (FR-R3-163) T003 — the negative control for shape B, "the host's
// answer asserted into shape at a boundary it does not control". Spec FR-017;
// plan.md DR-3.
//
// This file is a *planted* instance of the defect. `readRoutes` over
// `tests/lint/fixtures/` must report it with `uncheckedCast: true`, and the gate
// asserts that specifically rather than asserting that something matched.
//
// It carries shape B and ONLY shape B. Shape A's literal form appears nowhere in
// it, not even in this header — the absent case is defaulted *pessimistically*,
// to `{ ok: false, reason }`, which is correct code and which the shape-A term
// must therefore not flag. That makes this file do double duty: it is the
// positive control for one term and a near-miss for the other.
//
// The header is deliberately written *around* the other shape rather than
// quoting it, for the reason recorded in `absent-answer-as-success.fixture.ts`:
// the terms match file content, comments included.
//
// It can never fail the real gate: the real gate scans
// `src/ui/sidebar/commands/` only, and this file is under `tests/lint/fixtures/`.
//
// It is inert. Nothing imports it, nothing calls it, and it performs no I/O.

/** Stands in for `executeCommand`, which crosses the boundary as `unknown`. */
declare function hostAnswer(): Promise<unknown>;

declare function acknowledge(result: { ok: boolean; reason?: string }): Promise<void>;

/**
 * Read the host's answer through a cast. This is the defect: the value crossed a
 * VS Code command boundary as `unknown`, and an assertion tells the compiler a
 * fact nobody verified. The pessimistic default below is deliberately correct —
 * it is the shape-A near-miss this fixture also stands for.
 */
export async function uncheckedAnswerCast(): Promise<void> {
  const result = (await hostAnswer()) as { ok: boolean; reason?: string } | undefined;
  await acknowledge(result ?? { ok: false, reason: 'workspace-not-trusted' });
}
