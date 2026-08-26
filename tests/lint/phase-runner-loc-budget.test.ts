import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 057 Track 4 — regression guard. Pins the LoC budgets agreed
// in spec 057 (FR-005, FR-006, SC-001, SC-003) so a future contributor
// cannot silently regrow `phase-runner.ts` past the coordinator shell
// budget without updating the spec.

const REPO_ROOT = resolve(__dirname, '..', '..');
//
// Post-155 (S12) — +1, to 1028, for `evidencePolicy`'s FIRST READER. The field
// was validated, persisted, snapshotted and exported, and no code path consulted
// it; one line in the shell forwards it to the parser that now does. Written as a
// plain property rather than the spread-conditional this file favours, because
// the conditional form cost four lines to say the same thing and the parser's
// field accepts an explicit `undefined` for exactly that reason.
//
// Post-155 — phase-runner.ts HELD at 1027, not raised. The seam gate added after
// the security review found that `phaseDef.timeoutSeconds` was recorded at three
// sites in this file and applied at none: an authored per-phase bound that four
// records claimed and no process honoured. The fix routes the EFFECT through
// `effective-phase-timeout.ts` and leaves each record's shape exactly as it was —
// still omitted when the phase declares nothing, because `phase-runner.test.ts`
// pins that shape and changing it would rewrite every built-in phase's payload
// for no gain.
//
// An intermediate draft did collapse the record sites too and briefly measured
// 1025. That is recorded because the number is not the point: it was bought by
// changing what the audit says, which was never the defect. The budget is where
// it was, the defect is closed, and the shell took on no new responsibility —
// the resolution lives in its own module, as with the three recorder modules
// above it.
//
// FR-R3-105 — bumped phase-runner.ts +4, for the DEFENSIVE half of the argv bound
// (1035 -> 1039). One type import and a three-line comment; the guard itself replaced an
// existing line rather than adding one.
//
// WHAT IT BUYS. `phaseDef.model` is pushed as its own argv token at all three backends,
// and it was validated as a non-empty string only — so an operator-imported pipeline
// document supplying `model: "--dangerously-skip-permissions"` put that literal flag into
// the child's argv. Spawns are `shell: false`, so this is flag injection rather than shell
// injection: the exact authority the capability plan exists to narrow, granted through a
// field the narrowing never sees.
//
// WHY IT LANDS HERE AND NOT ONLY AT THE VALIDATOR. The validator closes the ingress, and
// a `FrozenRunPlan` persisted before that rule existed still carries whatever its document
// said. Re-resolving a frozen plan is forbidden — the freeze is the point of the freeze —
// so the value arrives at this request construction and is checked here. Same two-halves
// shape as `resolveRunOutputs`.
//
// WHY IT IS NOT CHEAPER. An earlier draft carried the whole argument at the call site and
// measured 1053. The reasoning moved to `src/contracts/argv-value.ts`, which is also the
// single authority both halves read — so the shell gained a guard and a pointer, not a
// policy. The alternative of inlining the pattern here would have put a second copy of
// "what is a safe argv value" in the file most likely to disagree with the validator.

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
// FR-R3-104 (FR-054) — bumped phase-runner.ts +9, to 1048, for the CLI version this invocation
// actually ran against.
//
// WHAT IT BUYS. The qualification record names the CLI versions a canary observed; nothing on the
// host observed the version it was DRIVING. So an operator who upgraded `claude` mid-feature
// crossed the protocol boundary that record vouches for, and when a parse later failed the
// evidence showed a qualified version while the machine had been running another one — a
// diagnosis unreachable from the record.
//
// WHY IT IS NINE LINES AND NOT TWENTY-EIGHT. An earlier draft carried the probe's null-registry
// case, its swallowed failure and the reasoning for swallowing it here, and measured 1067. This
// gate refused it, correctly: that is "how do we observe a version", which is not the shell's
// question. It moved to `src/runner/cli-version-probe.ts` as `observedVersionOf`, beside the TTL
// cache and the note on why the cache is neither per-activation nor per-phase. What remains in
// the shell is a field, one awaited call, one conditional key on the start payload and one spread
// on the metric payload — a forwarded value, not a policy.
//
// A VERSION, NEVER A PATH. `cliPath` is deliberately absent from every audit payload; the probe
// answers with the version token alone, bounded at 64 characters.
//
// +1 more, to 1049: the authored model is read ONCE into a local instead of twice inside the same
// conditional. Bought by a lint ratchet rather than chosen — the double read was also a double
// optional chain the compiler calls unnecessary — and the shape is better for the reason the
// argv-bound test now asserts: one read, one check, no second expression to disagree with it.
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
  // FR-R3-098 (T1294) — 1028 → 1029. One line: the `backend` parameter on
  // `invocationMetricPayload`. The usage extractor is now told which backend
  // produced the envelope rather than inferring it from the bytes, and this
  // method is the only site that spreads its result. The kind was already
  // resolved in `runInner` for audit attribution, so the five call sites pass a
  // value that was in scope; the import took an inline `type` specifier rather
  // than a line of its own. Nothing to extract — the parameter is the change.
  // FR-R3-096 — 1029 → 1035. Six lines: one `evidencePolicyDeclaredAt` argument
  // to `parseInvocation` and the five-line note recording that `phaseDef` here
  // is the frozen snapshot, which is the only place the origin is written and
  // therefore the only reason the value that reaches the parser can be trusted.
  // The note is the budget: a reader who assumes this is the catalog definition
  // would conclude the enforcement never fires. Nothing to extract — the
  // argument sits in the call it belongs to.
  { path: 'src/controller/phase-runner.ts', max: 1_049 },
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
