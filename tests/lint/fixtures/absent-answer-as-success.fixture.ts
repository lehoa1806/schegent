// Feature 202 (FR-R3-163) T002 — the negative control for shape A, "an absent
// host answer defaulted to a literal asserting success". Spec FR-017; plan.md DR-3.
//
// This file is a *planted* instance of the defect. `readRoutes` over
// `tests/lint/fixtures/` must report it with `absentAsSuccess: true`, and the
// gate asserts that specifically — not merely that something in the fixture
// directory matched. A control that would pass on an empty result, or on the
// other fixture having matched, is not a control.
//
// It carries shape A and ONLY shape A. Shape B's literal form appears nowhere in
// it, not even in this header: the host answer is typed by the declared return of
// `hostAnswer` rather than asserted at the call site, so the shape-B term must
// leave this file alone. The gate asserts that too, in both directions.
//
// The header is deliberately written *around* the other shape rather than
// quoting it. The terms match file content, comments included, so a fixture that
// spelled out the shape it does not carry would match both terms and quietly
// destroy the very separation it exists to demonstrate. That is finding F27's
// failure — a term matching prose about what a file does not do — reappearing one
// directory over.
//
// It can never fail the real gate: the real gate scans
// `src/ui/sidebar/commands/` only, and this file is under `tests/lint/fixtures/`.
// That is why the gate needs no exclusion list — a fixture inside the scanned
// root would make the gate permanently red, which is the crux plan.md D3 decided.
//
// It is inert. Nothing imports it, nothing calls it, and it performs no I/O.

interface MutationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Stands in for a VS Code command that returns nothing when Trust is refused. */
declare function hostAnswer(): Promise<MutationResult | undefined>;

declare function acknowledge(result: MutationResult): Promise<void>;

/**
 * Read the host's answer, defaulting absence to success. This is the defect:
 * `undefined` has a known cause — Workspace Trust refused and the handler never
 * ran — so `{ ok: true }` acknowledges a mutation that did not occur.
 */
export async function absentAnswerReadAsSuccess(): Promise<void> {
  const result = await hostAnswer();
  await acknowledge(result ?? { ok: true });
}
