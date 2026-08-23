import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 057 Track 4 — regression guard. Pins the LoC budgets agreed
// in spec 057 (FR-005, FR-006, SC-001, SC-003) so a future contributor
// cannot silently regrow `phase-runner.ts` past the coordinator shell
// budget without updating the spec.

const REPO_ROOT = resolve(__dirname, '..', '..');

// Feature 010 BUG-001 (Bugfix 2026-05-22) — bumped phase-runner.ts +10
// and phase-retry-evaluator.ts +30 to accommodate the FR-028 retry-decision
// projection sink (additive constructor params + projection emission with
// canonical FR-012 warning text).
//
// Feature 068 — bumped phase-runner.ts +10 to accommodate the FR-004
// `cli-invocation` audit emission (additive eventType union member +
// 7-line emission block right after `runner.invoke()` returns).
//
// Session ID capture — bumped phase-runner.ts +30 to accommodate
// `resumeSessionId` on inputs, `cliSessionId` on outputs, forwarding
// into InvocationRequest, and the `phase-start` audit payload update.
//
// Session reuse — bumped phase-runner.ts +80 to accommodate the
// `sessionReuse` field on PhaseRunInputs, `sessionReuse` audit payload
// telemetry, pre-phase compaction invocation (lightweight dummy call
// with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1 before the real invocation),
// and `sessionReuse` forwarding into InvocationRequest.
// Error Handling Audit (Bugfix 2026-07-31) — bumped phase-runner.ts +30 to
// accommodate the try-catch resilience wrapper around appendAudit so a
// full disk or permissions error does not crash the entire workflow.
//
// Feature 074 — bumped phase-runner.ts +30 to accommodate the
// BackendRunnerRegistry constructor overload, resolveRunner() per-invocation
// helper, and runner attribution on all audit payloads (pipelineMeta +
// startPayload).
//
// FR-R3-001 (T260) — bumped phase-runner.ts +15 for the `envelope` field on
// `PhaseRunInputs`, its forward into `promptBuilder.build()`, and the type
// import. Almost all of it is the comment recording why it is *one* field and
// not four: this file is a carrier for the envelope and must not learn to read
// its members, which is the single thing a future reader here could get wrong.
// No responsibility was added — the coordinator shell forwards one more input
// than it did — so the budget buys the note, not new work.
// Feature 098 (T018) — bumped phase-runner.ts +10. `assertPhaseRunnerPolicy`
// took an id and now takes the Phase's declared `sideEffects` alongside it, which
// costs one argument and one line at the call. The rest is the note recording why
// the assertion is here at all: this is the only site that sees a `git`-declaring
// Phase with no runner of its own, because both save gates return early on that
// shape. No responsibility was added — the coordinator shell still forwards a
// verdict it does not compute — so, as with FR-R3-001 T260 above, the budget buys
// the note rather than new work.
// FR-R3-047 (H-04) — bumped phase-runner.ts +30 for the stdin-delivery arm.
// Unlike the T260 and 098 bumps above, this one buys real work rather than a
// note: a new classification arm, checked above the existing chain. It is not a
// split, and the reason is coherence — every sibling arm (timeout, cancellation,
// clean-with-nonzero-exit) is decided here, and extracting one of five would put
// a decision somewhere no reader would look for it while leaving the other four
// in place. The rationale that would have cost another sixteen lines lives in
// specs/132-child-stdin-completion/contracts/stdin-delivery.md instead, which is
// why the arm costs 30 and not 46.
//
// Bumped again +10 during the same feature's review: the arm's guard narrowed
// from `raw.stdinDeliveryFailed` to `... && result.kind === 'clean'`, and the
// note records why, because the wrong version is the plausible one. A backend
// that refuses before reading — stale --resume id, bad flag, auth or credit
// refusal — exits fast and EPIPEs an undrained prompt, and the unnarrowed arm
// swallowed `rate_limited` (losing its reset-scheduled retry) and dropped
// fatal-signature classification. This is the budget buying a note again.
//
// Bumped again +20 during the same feature's code review, for audit evidence the
// early-return arms were dropping: the stdin arm now records the parsed audit
// block's file/command evidence (the parse is clean there, so that evidence
// exists and `fileChangeCounts: {0,0,0}` was a false record), and the timeout arm
// now carries `exitCode` and the runner's `diagnosticWarnings` — without the
// former the projection defaulted an absent code to 0 and recorded a clean exit
// for a SIGTERMed child, and without the latter a `stdin-delivery-failed` on a
// timed-out run reached no durable record at all.
const BUDGETS = [
  { path: 'src/controller/phase-runner.ts', max: 875 },
  { path: 'src/controller/phase-sidecar-reader.ts', max: 400 },
  { path: 'src/controller/phase-retry-evaluator.ts', max: 180 },
  // Raised from 100 on 2026-08-16. The truncation arm of `mapOutcome` stopped
  // returning 'failed' and now returns 'transient_error'; the budget is spent
  // on recording why, because a reader who assumed the old mapping was
  // deliberate is exactly how a required phase came to be failed on output
  // volume. No responsibility was added to the file — it is still pure
  // classification — so the fix is headroom, not a split.
  { path: 'src/controller/phase-outcome-mapper.ts', max: 110 }
] as const;

function countLines(absPath: string): number {
  const contents = readFileSync(absPath, 'utf8');
  // wc -l semantics: count newline terminators. A final newline-less
  // line still counts because we split and exclude the trailing empty.
  const lines = contents.split('\n');
  // Mirror `wc -l` exactly: it counts \n bytes.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

describe('feature 057 LoC budgets', () => {
  for (const { path: relPath, max } of BUDGETS) {
    it(`${relPath} ≤ ${max} LoC`, () => {
      const count = countLines(resolve(REPO_ROOT, relPath));
      expect(count).toBeLessThanOrEqual(max);
    });
  }
});
