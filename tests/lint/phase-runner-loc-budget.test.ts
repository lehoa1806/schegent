import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 057 Track 4 — regression guard. Pins the LoC budgets agreed
// in spec 057 (FR-005, FR-006, SC-001, SC-003) so a future contributor
// cannot silently regrow `phase-runner.ts` past the coordinator shell
// budget without updating the spec.

const REPO_ROOT = resolve(__dirname, '..', '..');
//
// FR-R3-086 — bumped phase-runner.ts +1 more, for the SECOND capability audit
// event (`capability-applied`). The security pass found that a grant left no
// trace: the bound lives in argv, argv is never written to the structured log,
// so a completed Run could not tell an operator whether its phase ran bounded.
//
// The +1 is a type import, and it is the CHEAPER of the two shapes tried. The
// first added a second string literal to the shell's event union, which would
// have meant editing this file again for every event the capability contract
// ever declares. Referencing `CapabilityRefusalEventType` instead moves that
// authority to `contracts/audit-events.ts`, where the events are declared — so
// the next one costs zero here. Recorded rather than absorbed, for the reason
// stated below.
//
// FR-R3-086 — bumped phase-runner.ts +7 for the capability refusal: one import,
// a two-line call site, and one member on the audit eventType union.
//
// The MECHANISM is not here, and that is what the +7 buys. `refuseUnenforceable
// Capabilities` lives in `capability-decision-recorder.ts`, in the shape
// `backend-posture-recorder.ts` and `process-tree-degradation-recorder.ts`
// already established: the coordinator shell calls it and does not learn what it
// does. An earlier draft put the whole method here and cost +27; extracting it
// took that back to +7, which is the forwarding cost of one more decision the
// shell coordinates.
//
// Recorded rather than absorbed because the reviewer brief's §6 is still open:
// `STATE-1` was closed on a ratchet and the brief asks whether the wrong half was
// closed. A budget raised without a stated reason is exactly the shape that
// question is about.

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
//
// FR-R3-058 / M-07 (2026-08-24) — 875 → 927 for the sensitive-phase arm: a
// `hostVerification` check on the timeout condition, and a failing return where
// a non-zero exit alongside a clean token used to be a `logger.warn` and a
// transition. The prose that justified it was moved OUT first, to
// specs/145-host-verifiable-gates/contracts/host-verification.md; what remains is
// the arm itself and a pointer. No responsibility was added — the file still
// decides one phase's outcome from one invocation's evidence — so the fix is
// headroom, not a split, on the same reasoning as phase-outcome-mapper.ts below.
// FR-R3-086 (security review) — bumped phase-runner.ts a further +5, to 1026.
//
// The mechanism shipped HALF-WIRED: the refusal read `inputs.phaseDef.capabilities`
// while the adapter read `request.capabilities`, and nothing forwarded one to the
// other. An UNENFORCEABLE set was refused correctly; an ENFORCEABLE one never
// reached the adapter, so a narrowed phase ran with the unbounded argv while a
// narrower set had been approved with the plan. Every test passed, because each
// half was covered against its own input and nothing drove one into the other.
//
// The +5 is the forwarding: one import (three lines, multi-name), one spread, one
// comment. The construction of the fields is NOT here — `capabilityRequestFields`
// lives beside the refusal in `capability-decision-recorder.ts`, mirroring
// `policyRequestFields`, so the shell forwards a decision it does not make.
//
// Recorded rather than absorbed, on the same ground as the +7 above: the reviewer
// brief's §6 is still asking whether STATE-1 closed the wrong half, and a budget
// raised without a stated reason is exactly that shape.
const BUDGETS = [
  // FR-R3-064 — bumped phase-runner.ts +30. The per-run backend-posture record
  // was written inside `run()` first and this gate refused it, correctly: at +123
  // it was a responsibility, not a forwarded decision. It now lives in
  // `controller/backend-posture-recorder.ts`, on the same reasoning feature 057
  // used for `PhaseSidecarReader`, `PhaseRetryEvaluator` and
  // `PhaseOutcomeMapper`. What remains in the shell is what a shell should have:
  // one constructor parameter, one construction, one awaited call, and the note
  // saying why the call sits before `phase-start`. The gate is the reason the
  // split happened rather than the headroom being taken, which is what it is for.
  // FR-R3-075 (feature 152) — 957 → 995 for the deadline arm: checked ahead
  // of the idle arm so the two bounds can never both claim a run, recording
  // the exit code the idle arm's documented omission does not, plus the
  // maxDurationMs input and its pass-through to the runner. The arm is the
  // decision chain's own shape and cannot move without a second oracle.
  // FR-R3-080 / T1075 (2026-08-25) — 995 → 1014. Nineteen lines: the drain
  // parameter with the note on why it is positional (109 harnesses construct
  // this class positionally, so a required parameter is not available cheaply),
  // and the fold into the phase-end warnings with the reason the codes are
  // drained rather than read. Nothing to extract: the fold is where the
  // warnings are assembled.
  { path: 'src/controller/phase-runner.ts', max: 1_027 },
  // FR-R3-052 / H-03 (2026-08-24) — 400 → 415 for the size check that was
  // missing. `stat()` was already called here and only `isFile()` was read, so
  // `readFile()` took a multi-GiB sidecar wholly into memory. The bound, the
  // refusal, and the constant are the whole of the addition; the rationale lives
  // in the item record, and the shared reader in src/lib/bounded-read.ts. Nothing
  // movable was left here — this file's job is reading one sidecar safely, and a
  // size bound is part of that job rather than a new one.
  // FR-R3-080 / T1067 (2026-08-25) — 415 → 439 for the component walk. The read
  // opened with `O_NOFOLLOW`, which covers the leaf and says nothing about the
  // components above it; the walk covers both. Twenty-four lines: the call, the
  // refusal mapping that keeps `path-symlink-redirect` distinct from
  // `missing-sidecar`, and the note recording what the old comment was right
  // about and what it left out. Nothing to extract — it is one open.
  { path: 'src/controller/phase-sidecar-reader.ts', max: 439 },
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
