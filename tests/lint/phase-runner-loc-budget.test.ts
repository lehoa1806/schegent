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
  // FR-R3-117 — bumped phase-runner.ts +20 (1049 -> 1069) for the verdict-default
  // inversion. What the twenty lines buy:
  //
  //   * FIVE of them are one `verdictBasis:` property on each of the five
  //     `phase-end` emissions. Folding them into `pipelineMeta()` would have cost
  //     one line instead of five and was rejected: that helper also feeds
  //     `phase-start`, where a terminal verdict is not a fact yet, and buying
  //     four lines by recording a basis before the phase has been judged is the
  //     kind of trade this budget exists to refuse.
  //   * The rest is the resolution call and the docblock explaining that an
  //     ABSENT `hostVerification` no longer means `model-token`. That inversion is
  //     the single highest-consequence default change this product has made, and a
  //     reader who assumes the old meaning is exactly the failure mode the
  //     phase-outcome-mapper entry below was written about.
  //
  // NO RESPONSIBILITY WAS ADDED. The rule itself lives in
  // `src/config/phase-runner-policy.ts` beside `writesGitMetadata`; the shell
  // calls it and forwards the answer, which is what a shell should do. That is
  // why this is headroom rather than a split.
  // Bugfix 2026-09-02 — 1069 → 1073 for the `detail` field on the
  // `session-compact-failed` warning. Four lines: one property and a three-line
  // note.
  //
  // WHAT IT BUYS. This catch swallowed the compaction error entirely and logged a
  // phase and an iteration. A pin to a Model that does not exist therefore failed
  // at every phase boundary of an eight-hour run — dropping the session each time
  // and restarting the next phase cold — and no operator-readable sink named the
  // Model. The one sentence that did reached `cli-transport.log` only. The `err`
  // binding was on the eslint baseline as unused for the same reason, so the
  // record was accurate and its significance invisible.
  //
  // WHY IT IS NOT CHEAPER. An earlier draft wrapped the message in
  // `logger.sanitize` here and carried the whole rationale, and measured 1080. Both
  // came back out: `warn` folds context into the line before `write()` sanitizes
  // it, so the explicit call was a second redaction of an already-redacted string,
  // and the reasoning about bounding and redaction belongs beside `failureExcerpt`
  // in `session-compactor.ts`, which is where it is. What remains here is the
  // field and the one thing a reader could get wrong — passing `err` itself, which
  // would put a stack trace into a sink that is not access-controlled.
  //
  // NO RESPONSIBILITY WAS ADDED. The excerpt is built by the compactor; the shell
  // logs a string it was handed. Headroom, not a split.
  //
  // Feature 194 (FR-001, FR-002, 2026-09-03) — 1073 → 1074 for `cause: 'cap_exhausted'` on
  // the payload literal in `appendCapExhaustedPhaseEnd()`, beside the existing
  // `terminationReason: 'cap-exhausted'`. One line: the published contract
  // (`specs/010-pipeline-resilience/contracts/audit-events.md` §"phase-end —
  // new payload.cause field") has enumerated this value since feature 010; the
  // emitter never wrote it. No responsibility was added — the shell already
  // owned this payload literal and gained one more property on it — so the fix
  // is headroom, not a split. (The rest of this feature's cause fix lives in
  // `src/audit/audit-payload.ts`'s `projectPhaseEnd`, a different file with its
  // own budget, because that is where the field was actually being dropped.)
  //
  // Feature 194 (FR-010, T017, 2026-09-03) — 1074 → 1088 to surface `PhaseRetryEvaluator.
  // maybeEmit()`'s return value (the `stalled` count it just computed) as
  // `stalledCount` on `PhaseRunOutput`. Fourteen lines: a documented optional
  // field on the interface, capturing the call's own return value into a
  // local instead of discarding it, and one conditional spread on the
  // returned object. No responsibility was added — the shell already called
  // `maybeEmit()` and constructed this return object; it now reads a value
  // that call already produced rather than a second computation elsewhere,
  // which is the reasoning contract rule C3.3 exists to enforce.
  //
  // Feature 194 (FR-009, T019, 2026-09-03) — 1088 → 1096 for `evictStagnationTracker()`,
  // an eight-line forwarding method to the `PhaseRetryEvaluator` instance
  // this shell already owns and constructs. `RunDriver` holds only this
  // `PhaseRunner`, not the evaluator, so it calls here when
  // `PostPhaseDecision.evictStagnationTracker` is true. Same shape as
  // `appendCapExhaustedPhaseEnd()` immediately below it: the shell forwards
  // to a mechanism it does not implement.
  //
  // Feature 194 (T027, 2026-09-03) — 1096 → 1106 for the comment above
  // `appendCapExhaustedPhaseEnd()`. Ten lines, all comment: the existing note
  // had cited the contract and described `payload.cause` since feature 010
  // while the code beneath it omitted the field, and the T005 discovery — that
  // fixing the literal here was necessary but not sufficient, because
  // `audit-payload.ts`'s `projectPhaseEnd()` also had to gain the field — is
  // exactly the kind of gap a future reader of this comment alone would repeat.
  //
  // Feature 194 code review (2026-09-04) — 1106 → 1112. The `cause` property
  // added above went in as the bare literal `'cap_exhausted'` on a payload
  // typed `Record<string, unknown>`, while `projectPhaseEnd()` decides whether
  // the field survives to disk by comparing it for identity with the exported
  // `CAP_EXHAUSTED_CAUSE`. This shell is the field's SOLE producer, so those two
  // were coupled by an unchecked string in the one place it mattered; the
  // constant is now imported (no new import line — it joined the existing
  // `audit-payload` specifier) and six lines of comment record why a literal
  // here silently reproduces the Delta 1 defect the note above narrates.
  //
  // Feature 194 code review (SC-007, 2026-09-04) — 1112 → 1114. Two lines on
  // `evictStagnationTracker()`: `phaseId` became optional, and omitting it now
  // forwards to the evaluator's whole-Run eviction. The end-of-drive backstop in
  // `run-driver.ts` was passing `run.currentPhase`, which by then names the phase
  // the Run ADVANCED TO — `'done'` on a completed Run — so it deleted a pair
  // nothing had written while an earlier looping phase's entry outlived the Run
  // inside a window-scoped evaluator. Two forwarders would have cost more here
  // and read no better: the optional argument is the same question ("which of
  // this Run's phases?") with "all of them" as an answer.
  //
  // BUG-001 / FR-009 (2026-09-08) — 1114 → 1144, for `completedAwaitingExit`'s
  // FIRST READER. The same shape as the `evidencePolicy` bump above and the
  // `timeoutSeconds` HOLD below it: a field the runner set correctly, documented
  // precisely, and no code path consulted. Here that cost a `finalize` phase that
  // had passed 9 of 9 checks and merged 165 files, failed on exit 143 — the
  // runner's own SIGTERM after FR-025's settle window, read back as the backend's
  // verdict.
  //
  // WHY +30 AND NOT +2. The predicate is one expression; the rest is the argument
  // for it. Two arms already enforced this rule inline and a state that overrides
  // nothing reached one of them unsurveyed, so the next reader needs to know why
  // the check is a derived rule rather than a third conjunct, and why it cannot
  // reach the timeout arms. A draft that stated only the mechanism measured +12
  // and is not recorded as the better outcome: the deleted half is the half that
  // stops the conjunct being added back.
  //
  // Not extracted to its own module, unlike `effective-phase-timeout.ts`. That
  // one moved an EFFECT the shell was performing; this is a two-line question
  // about a field on `raw`, asked at the one site that acts on the answer, and a
  // module boundary around it would add indirection without removing
  // responsibility.
  { path: 'src/controller/phase-runner.ts', max: 1_144 },
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
  // Feature 194 (FR-006 through FR-009, 2026-09-03) — 180 → 296 for the stagnation
  // tracker: a real, new stateful subsystem, not headroom on existing work.
  // What the 116 lines buy: `StagnationEntry` and the nested
  // `Map<runId, Map<phaseId, entry>>` (data-model.md §4's structure, chosen
  // over a concatenated-string key so a separator collision can't merge two
  // Runs' figures); `evictStagnationTracker()`, the public method
  // `RunDriver` calls via `PhaseRunner` when `PostPhaseDecision.
  // evictStagnationTracker` is true (T012, T019); the comparison call inside
  // `maybeEmit()` that only touches the tracker when `decision === true`;
  // `updateStagnationTracker()`, the AST-driven judged-set snapshot and
  // count update; and the module-level `judgedSnapshotsEqual()`, which
  // treats an appearing/disappearing judged identifier as a change (FR-009).
  //
  // WHY IT IS NOT CHEAPER. A single un-nested map keyed by a template string
  // (`` `${runId}:${phaseId}` ``) would have cost fewer lines, and was
  // rejected: `runId` and `phaseId` are both operator- or catalog-supplied,
  // and a chosen separator is one more place two distinct keys could
  // collide. The nested map is also the reason eviction is one call —
  // `perPhase.delete(phaseId)` — rather than a key reconstruction at every
  // call site.
  //
  // NO RESPONSIBILITY WAS ADDED TO `maybeEmit()` ITSELF. It gained one
  // conditional call and one spread on the payload; the mechanism is a
  // sibling private method, mirroring how this file already separates the
  // parse/evaluate/append responsibilities it had before this feature.
  //
  // Feature 194 (SC-007, T012, 2026-09-03) — 296 → 311 for `retainedStagnationKeyCount`,
  // a read-only getter summing the nested map's sizes, plus its docblock.
  // Fifteen lines, and the spend is on being ASSERTABLE. SC-007 bounds memory
  // — one retained figure set per looping pair, a 2-iteration run and a
  // 100-iteration run alike, back to zero once all settle — and no emitted
  // field can witness that: a per-iteration history would produce the
  // identical `stalled` sequence, so the payload cannot tell the bounded
  // implementation from the unbounded one. The alternative was a test reaching
  // into `stagnationTrackers` directly, which would then fail on any internal
  // reshape rather than on a behaviour change, and would make the private
  // field's shape a de-facto public contract. No responsibility was added: the
  // getter reads state this file already owns, returns a count rather than the
  // map, and is called from nothing in `src/`.
  //
  // Feature 194 code review (FR-009, 2026-09-04) — 311 → 339 for two
  // corrections to `updateStagnationTracker()`, both of which made it
  // OVERSTATE, which FR-009 forbids outright:
  //
  //   * The judged-set snapshot is now built on `Object.create(null)`, not a
  //     `{}` literal. The DSL lexer admits `__proto__` as a metric identifier
  //     and the audit-log parser produces it as a real own key, so on a plain
  //     literal the snapshot write invoked the inherited `__proto__` setter and
  //     stored nothing — every snapshot compared equal to every other and the
  //     count climbed while the judged figure moved on every iteration.
  //   * An iteration in which NONE of the judged identifiers was measured now
  //     evicts and returns absent instead of storing an empty snapshot. A
  //     condition over absent figures is truthy at zero (`resolveTerm` reads a
  //     missing identifier as 0), so that is the loop-to-cap case, and empty
  //     snapshots compare equal to each other — the count grew across a gap in
  //     which nothing was measured at all.
  //
  // Twenty-eight lines, and the majority are the two rationales: both defects
  // are invisible at the call site and a later reader who "simplifies" either
  // one back reintroduces an overstate that no emitted field can distinguish
  // from a real stall. No responsibility was added — the method already owned
  // the snapshot and the count.
  //
  // Feature 194 code review (2026-09-04) — 339 → 352. Thirteen lines, all of them
  // the recorded justification for a reviewed finding that turned out to be a
  // false positive: `maybeEmit()` does not reset the stagnation count on a FALSY
  // iteration, which reads locally like a stale count surviving a move in the
  // judged figures. It cannot, and the proof is in three other modules — a falsy
  // retryCondition always advances (`phase.ts`), advance always sets
  // `evictStagnationTracker` (`phase-sequencer.ts`), and the driver evicts before
  // the phase can be re-entered (`run-driver.ts`). The argument is written at the
  // retention it justifies rather than in a document, because the reader it has
  // to reach is the one about to "simplify" the branch, and that reader is in this
  // method. A defensive reset here would be a second spelling of the eviction
  // that already happens, which is the change the note exists to prevent.
  //
  // Feature 194 code review (SC-007, FR-009, 2026-09-04) — 352 → 364, and the
  // net hides two changes in opposite directions:
  //
  //   * +29 for `evictRunStagnationTrackers()` and a corrected docblock on the
  //     per-phase form. SC-007's bound had no catch-all: the end-of-drive funnel
  //     evicted ONE key read off `run.currentPhase`, which has advanced past the
  //     phase that looped, so the bound rested entirely on every per-phase
  //     eviction firing, and one missed advance retained a figure map for the
  //     life of the window. The docblock also enumerated its callers as the
  //     `PostPhaseDecision` path alone, which was true of one of the five.
  //   * −17 for `judgedSnapshotsEqual()`, deleted. It hand-rolled record
  //     equality — two `Object.keys` allocations, a length compare, a
  //     `hasOwnProperty` per key — over two records whose key sets are both
  //     drawn from `judged`, the array in scope four lines above the call. The
  //     comparison is now `judged.every((n) => prior.metrics[n] === snapshot[n])`,
  //     which judges presence and value together exactly as before (absent on
  //     one side reads `undefined` and never equals a number; absent on both
  //     reads equal, which is spec.md's "missing on both counts as unchanged").
  //     Deleting it also retires an unstated precondition: as a generic-looking
  //     module-level helper it was only correct for prototype-free records, so a
  //     later caller handing it a `{}` literal would have compared a judged
  //     `__proto__` through the inherited accessor — the defect the entry above
  //     records fixing one line away from it.
  //
  // Feature 194 code review (2026-09-04, later the same day) — 364 → 363, a
  // ratchet DOWN, which needs a note for the opposite reason the raises do. Two
  // review findings moved this file after the entry above was written: one fix
  // rewrote a comment longer and broke this budget outright, and the fix for
  // that cut eleven lines of genuine duplication back out, landing at 363. The
  // ceiling stayed at 364 and the file no longer touched it. A one-line margin
  // is exactly the slack this table's convention exists to deny — it lets the
  // next addition arrive with no note at all, which is the whole mechanism —
  // so the ceiling follows the file down rather than banking the line.
  // Lowering it costs nothing: the eleven lines were duplication of prose in
  // two other files, so no future reader is owed them here.
  //
  // The ceiling still sits at the file, as all four entries in this table do
  // (margins today: 0, 1, 0, 0). That is this gate's convention and not an
  // oversight — it is a ratchet, so every addition to a budgeted file has to
  // arrive with a note like this one. The sibling gate's `tightMargin` rule
  // (FR-R3-119, tests/lint/source-loc-budget.test.ts) requires headroom instead;
  // it governs that table's ceilings, not these, and granting slack here to
  // satisfy a rule that does not apply would retire the ratchet for nothing.
  { path: 'src/controller/phase-retry-evaluator.ts', max: 363 },
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
