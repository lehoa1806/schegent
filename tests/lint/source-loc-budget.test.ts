import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(REPO_ROOT, '..');

/**
 * A ceiling somebody chose, or a waiver somebody decided. FR-R3-027 made these
 * two different types because they were previously the same one: a waiver was
 * expressed as the number `10_000`, which is indistinguishable — to every reader
 * and every tool — from a budget. A waived entry carries no `maxLines` at all, so
 * "a waiver with a ceiling" is unrepresentable rather than merely discouraged,
 * and `typecheck:tests` is what enforces it.
 */
/**
 * How far a high-water mark may sit above its file before it is stale. Small
 * enough that ordinary editing does not churn the number, large enough that a
 * refactor removing a hundred lines is not immediately a failing test.
 */
const RATCHET_SLACK = 100;

interface CeilingEntry {
  readonly path: string;
  readonly maxLines: number;
}

interface WaivedEntry {
  readonly path: string;
  readonly waiver: {
    /** What was decided, in the decision's own words. */
    readonly decision: string;
    /** ISO date the operator took it. */
    readonly decidedOn: string;
    /**
     * Where it is written down — a path, never a line number. The previous
     * comment here cited "plan.md lines 26 and 66"; the decision now sits at
     * lines 31 and 71 of that file. A reference that rots is not a reference,
     * so the gate below resolves this path on disk and the quoted `decision`
     * is what a reader greps for.
     */
    readonly reference: string;
    /**
     * The file's size when this waiver was last reconciled — a ratchet, not a
     * ceiling.
     *
     * The decision these two files carry retired the *budget* as a forcing
     * function: neither is forced to extract helpers, and neither gets an
     * arbitrary number to fit under. That decision stands. What it left behind
     * was no forcing function at all, and the 2026-08-22 architecture review
     * called that out as STATE-1 — "a waiver that removed the forcing function
     * without replacing it".
     *
     * Growth used to be `console.log`ged on every run and gated by nothing. A
     * console.log inside a passing test is a signal nobody reads: between the
     * review naming the file at 2,499 lines and this mark being set, it reached
     * 2,512 and no one noticed.
     *
     * A high-water mark is not the ceiling the decision retired. It forbids
     * growth, which is a different thing from forcing extraction: the file can
     * be refactored freely, held at its size, or shrunk. It cannot get bigger
     * without someone raising this number in a diff and saying why.
     */
    readonly highWaterMark: number;
  };
}

type BudgetEntry = CeilingEntry | WaivedEntry;

function isWaived(entry: BudgetEntry): entry is WaivedEntry {
  return 'waiver' in entry;
}

/**
 * The factor at which a budget stops being a ceiling and starts being a waiver
 * in disguise. Measured 2026-08-22 across all twelve entries: ten sat at or below
 * 2.10x their file's size (the highest being pipeline-config.ts at 900/428) and
 * two sat at 4.00x and 5.49x. Three is the gap between those two groups, so the
 * gate catches the waiver shape without forcing a judgement call on any existing
 * entry. Tighten it against a re-measured distribution, not against taste.
 */
const WAIVER_FACTOR = 3;

const BUDGETS: ReadonlyArray<BudgetEntry> = [
  // P4 activation extraction ratchet: 1,500 → 1,305. Backend/evidence
  // composition and Stage-2 dashboard/command lifecycle now have focused
  // owners under src/activation.
  // Feature 084 (T071) — 1,305 → 1,360 for the two process-YAML host seams.
  // They are the same shape as the metrics adapter they sit beside: closures
  // over `workspaceRoot`, `logger`, and
  // `vscode` that keep every filesystem path out of the IPC boundary. Moving
  // them under src/activation was measured first and lands at ~1,307, so it
  // buys headroom rather than compliance while splitting one adapter family
  // across two files; the ceiling is raised instead.
  // Feature 088 (T040) — 1,360 → 1,362, a recorded deviation from plan D7,
  // which budgeted one line. The connected-run service itself moved out, to
  // `createConnectedRunService` in src/activation/ui-wiring.ts, exactly as D7
  // directed; what could not move is that two already-constructed consumers
  // need the same instance — the projector (`getConnectedRuns`, for the
  // snapshot) and the message router (`connectedRuns`, for the two commands) —
  // and both literals are built here. That is one construction line plus one
  // reference each. Constructing the (stateless) service twice inline would
  // have bought the const line back while putting a factory call inside a
  // per-projection closure, which is worse code for a line of budget.
  // Feature FR-R3-006 (T352) — 1,362 → 1,382 for the reset transaction's host
  // wiring, against a ceiling that had zero to give. Extraction was measured
  // first and is most of the change: the quiesce wait, the stage-2 support
  // factory, and both activation-path recovery helpers moved out, to
  // src/commands/reset-wiring.ts, which buys 77 lines (1,459 → 1,382). What
  // could not move is the port literal, and it is in this file by definition —
  // `ResetHost` closes over three locals of `activate()` (`stage2`,
  // `tearDownStage2`, `ensureStage2`), and the reason it is constructed after
  // the lifecycle rather than beside the store is the reason the comment sits at
  // that site. The remainder is one field on `Stage2Wiring`, the command
  // registration that moved with the port, and three call sites. Raised to
  // exactly what the file measures, per the convention above.
  // Feature FR-R3-007 (T358) — 1,382 → 1,391 for the CLI transport sink's
  // wiring, against a ceiling that had one line to give. Nine of those lines
  // are the construction and the reason for its shape; extraction is what the
  // shape already is — the sink, its per-emit settings accessor and the
  // production factory all live in src/monitor/cli-transport-sink.ts, and
  // `createCliTransportSink` exists precisely so this file holds a call rather
  // than a deps literal. What cannot move is that the monitor is constructed
  // here and the recorder is now a required constructor argument, so the two
  // must meet in this file. Requiring it rather than defaulting it is the point:
  // an optional recorder would make this one line load-bearing in the way
  // `ownership-registry-wiring.test.ts` describes, where omitting it captures
  // nothing and no test fails. Raised to exactly what the file measures, per the
  // convention above — and note that the measure is `lineCount()` below, which
  // counts the empty segment after the final newline, so it reads one higher
  // than `wc -l`. Setting a ceiling from `wc -l` is what put this entry one line
  // short on the first attempt.
  // Feature FR-R3-008 (T385) — 1,391 → 1,405 for the liveness recorder's
  // wiring, against a ceiling that had zero to give (the previous entry raised
  // it to exactly what the file measured). Extraction is what the shape already
  // is: the coalescing lives in src/monitor/activity-coalescer.ts and the write
  // rule in src/controller/run-liveness-recorder.ts, so this file holds neither.
  // What cannot move is that the monitor observes output and the controller
  // persists it, and only this file constructs both — plus the ordering between
  // them, which is the whole reason the fourteen lines are here rather than in a
  // helper: the monitor is built in `wireStage2` well before the controller, so
  // the recorder is late-bound through a `let` that the adapter closes over and
  // one assignment closes after the controller exists. That is the same shape as
  // `telemetryProjector` below, and putting it behind a `createLateBound…()`
  // factory was measured and rejected — it buys about four lines by hiding an
  // idiom this file already uses twice, and by moving the null window (the span
  // in which an observation is dropped) out of the file whose statement order
  // defines it. `activity` is a *required* constructor argument on
  // `ClaudeCliMonitor` for the reason the FR-R3-007 entry above gives: optional
  // would make this wiring silently omissible with no test failing. Raised to
  // exactly what the file measures, per the convention above.
  //
  // Phase-log-tail extraction ratchet: 1,405 → 1,281. The first *downward* entry
  // since the P4 pass at the top, and it is deliberately not attached to a
  // feature. Every raise above is a correct argument that the feature's own
  // wiring could not move, and each one is still correct; what accumulated was
  // unrelated pre-existing bulk that per-feature scope forbids touching, so a
  // ceiling that only ever rises stops being a forcing function and becomes a
  // changelog. Feature 020's tail block moved whole to
  // src/activation/phase-log-tail-wiring.ts. It qualified on shape, not on size:
  // the block had exactly two outward references — the service the router reads
  // and the dashboard-bridge binding — and its registry, task-leave listener set
  // and previous-in-flight-id cursor were private to it while sitting in scope
  // for the 300 lines that follow. Eight imports were used by nothing else and
  // went with it. Set to exactly what the file measures; this is now below the
  // 1,305 the P4 pass reached, so the next raise starts from a real floor.
  //
  // FR-R3-009 / FR-R3-010 — 1,281 → 1,302, against a ceiling the ratchet above
  // left with nothing to give. Two features, and neither put its subject matter
  // here: FR-R3-009's rollup writer and terminal recorder are constructed in
  // src/activation/run-safety-wiring.ts and reach this file as one input on a
  // call that already existed, and FR-R3-010's evidence corpus reader lives in
  // src/services/history/. What lands here is the wiring that only this file
  // can do.
  // Fifteen of the lines are FR-R3-010's. Eight are the history-evidence
  // adapter in the router literal — the same closure-over-`workspaceRoot` shape
  // as the `metricsService` adapter it sits beside, and there for the same
  // reason: the corpus reader is reached through it and the handler never
  // resolves a root itself. Extraction was measured and buys three lines (a
  // `createHistoryEvidenceService()` call plus its import, against five
  // construction lines) while splitting the router's adapter family across two
  // files, which is the trade the feature-084 entry above already weighed and
  // declined. The other seven are two imports and the `v12MigrationEvents`
  // declare/assign/forward triple. That triple cannot move: the four migration
  // event lists are four `let`s outside a `try` over `store.initialize()`,
  // because the writer that forwards them does not exist until after the call
  // that produces them, and that ordering is the whole reason feature 092's
  // v10 events went unaudited. One migration is one line in each of the three
  // places, by construction.
  // Set to exactly what the file measures, per the convention above.
  //
  // Feature 098 (T058b) — 1,302 → 1,311, against a ceiling the entry above left
  // with nothing to give. The feature's subject matter is not here: the
  // empty-catalog refusal is decided in
  // src/services/scheduled-start-coordinator.ts, which owns the `EmptyCatalogGate`
  // type, the disarm, and the failure handling around the notice, and the words
  // it says come from src/contracts/empty-catalog-guidance.ts. What lands here is
  // the one thing only this file can do: bind the gate's two closures to
  // `activeCatalog` and `notifier`, both locals of `wireStage2`. Neither can move.
  // Reading the catalog through `activeCatalog` on every probe rather than
  // capturing a size is the requirement — a coordinator built before the first
  // import must see what the operator imported after it — and a factory taking
  // both locals as arguments would cost an import and a call to hide two
  // one-line closures. Five of the nine lines are the comment that says so, which
  // is the same trade every entry above made. Optional on `Deps` and required at
  // this site, per the FR-R3-007 entry's reasoning: a gate is what makes the
  // refusal reach an operator who is not looking at a webview, so the wiring is
  // the behaviour. Set to exactly what the file measures.
  //
  // Feature 098 residual (FR-031a, the gate's second reader) — 1,311 → 1,318,
  // against a ceiling the entry above set to exactly what the file measured.
  // Same gate, second consumer, and the second is the one that made the first
  // incomplete: `refuseOnEmptyCatalog` leaves a queue `idle-pending` with its
  // deadline persisted and its timer dropped, which is precisely the state the
  // schedule watchdog's sweep exists to re-arm, so a coordinator that refuses
  // and a watchdog that does not know it refused undo each other on the next
  // tick. The decision is still not here — src/controller/schedule-watchdog.ts
  // owns the skip and the line it logs. What lands here is the one closure only
  // this file can write, for the reason the entry above gives: `activeCatalog`
  // is a local of `wireStage2`, and it is read on every probe rather than
  // captured so that an import lifts the hold. Six of the seven lines are the
  // comment saying which of the two gates this is, and they earn their place —
  // a reader who takes this for a copy of the coordinator's binding deletes it.
  // Set to exactly what the file measures.
  //
  // Feature 102 (T038, T051, T055 — FR-022, FR-037) — 1,318 → 1,329 for the two
  // provenance bindings, both of which are the shape the two entries above have
  // already ruled on: a closure over a local of `wireStage2`, read live rather
  // than captured.
  //
  // `resolveCatalogVersion` reads the Active version through `catalogSession`,
  // which is reassigned whenever the catalog reloads, so a captured value would
  // pair one window's frozen body with another read's version — the exact defect
  // FR-022 exists to prevent. Five of its six lines are the comment saying that
  // `'pipeline'` is named at this seam and only here, and they earn their place:
  // a reader who takes it for a general resolver extends it to Workflows, which
  // FR-026 forbids.
  //
  // The run-plan enumerator is that closure twice over. `queue` and `store` are
  // both locals, and the store is constructed *before* the queue, so the binding
  // cannot be an argument even in principle — it has to be a thunk written at
  // this site. Extraction was measured before raising: both bindings behind one
  // helper module buys two lines and costs an import and two call sites to hide
  // two one-line closures, which is the trade the first entry above declines by
  // name. What did move is everything with a rule in it — which runs count as
  // live, and the terminal-status filter that decides, are in
  // src/activation/run-provenance-enumeration.ts, and the reader retention asks
  // is in src/catalog/run-provenance-queue.ts. Neither could live here: the
  // second is inside the purity boundary `tests/lint/catalog-purity.test.ts`
  // guards. Set to exactly what the file measures.
  // Feature 103 (T031) — 1,329 → 1,335 for the run-origin port, against a
  // ceiling the entry above left with nothing to give. Five of the six lines
  // are the projector dep and the reason for its shape; the sixth is an import.
  // Extraction is what the shape already is: the rule that turns a queue item
  // into a `RunOriginRef` lives in src/services/run-origin-resolver.ts, and the
  // recorder's half of the same wiring moved into `createHistoryRecorder` in
  // src/services/history-recorder.ts as part of this task — which is the
  // consolidation the `workflow-controller.ts` entry below had recorded as
  // worth making on its own terms. It could not absorb this site too: the
  // factory builds a recorder, and this is a projector dep.
  // What cannot move is the closure, and it is in this file by definition —
  // `store` is a local of `activate()`, so the binding has to be written where
  // the projector is constructed, which is the trade the run-plan enumerator
  // entry above declines by name. Set to exactly what the file measures.
  //
  // FR-R3-056 / H-01 (2026-08-24) — 1,335 → 1,343 for the capability posture: the
  // configuration read that supplies `allowUncontained`, and deferring the credit
  // watchdog's runner behind a thunk so an uncontained refusal no longer kills
  // activation before it can say why. Both are wiring, and wiring is what this
  // file is; the policy itself lives in
  // src/services/backend-containment-policy.ts and the rationale in
  // docs/architecture/agent-capability-posture.md, so nothing movable was left
  // here. Prose trimmed before raising, per the note on general-settings.ts.
  // FR-R3-064 — bumped +12. The posture the runner registry already reads at
  // activation is now also read per emission for the per-run audit record, so the
  // wiring site gains one reader function, one accessor object, and the note
  // recording that the difference between the two uses is WHEN, not WHAT. No new
  // responsibility: `extension.ts` still only wires.
  { path: 'src/extension.ts', maxLines: 1_355 },
  // P4 phase-control and lifecycle-auditor extraction ratchet: 1,200 → 730.
  // This file owns only the workflow facade, run dispatch, deletion, retry
  // entry, and persistence.
  // Feature 092 (T137, BUG-001) — 730 → 750 for the execution lease's terminal
  // release (FR-033a), against a ceiling that had two lines to give. The logic
  // moved out, to `releaseExecutionLeaseForTerminalRun` in
  // src/services/execution-lease-release.ts; extraction was measured first and
  // buys 44 lines (794 → 750). What could not move is the wiring, and it is in
  // this file by definition: the two terminal transitions the fix exists to
  // cover — `handleUnexpectedWorkflowError` and `deleteTask`'s task-removal
  // cancel — both live here, the `RunDriver` dep that covers the ordinary
  // funnel is constructed here, and the drain coordinator and the terminal path
  // must address the same lease manager, which is what turned one inline
  // constructor argument into a named const. The remainder is one import, one
  // bound field, four constructor lines, and two call sites.
  // Feature 093 (T027) — 750 → 833 for the per-queue run record, against a
  // ceiling that had one line to give. Every `getRun`/`setRun` in this file now
  // names the queue it addresses, and the eight phase controls each gained a
  // queue to resolve. Extraction was measured first and buys 25 lines
  // (858 → 833): the resolution rule itself moved out, to
  // `resolveControlTarget` in src/controller/sole-run-resolver.ts, where it sits
  // beside the sole-Run rule it delegates to, and the resolve-or-refuse preamble
  // the eight controls repeated verbatim folded into one private `control`
  // helper. What could not move is the threading, and it is in this file by
  // definition: `startNew`, `deleteTask`, `retryPhaseNow`, `resumeExisting`,
  // `resumeExistingFromActivation`, and `persistTransition` are the sites that
  // read and write the record, and each needed the queue plus a recorded note on
  // whether its Run-id comparison survives the reshape (T040 sweeps the ones
  // that do not). Moving any of them out would relocate a pre-existing
  // responsibility to buy budget, which is the drive-by refactor the ratchet
  // exists to make unnecessary rather than to force.
  // Feature 093 (T042) — 833 → 902 for the per-queue driving context, against a
  // ceiling that had zero to give (the file measured exactly 833). Extraction
  // was measured first and is the larger half of the change: `RunSession`, the
  // `Map<queueId, RunSession>` that holds them, and the whole RS-3/RS-4/RS-5
  // disposal rule moved out, to src/controller/run-session.ts, which is also
  // where the cap's `sessions.size` will read from (T072) rather than from a
  // counter beside it. What could not move is the wiring, and it is in this file
  // by definition: the `RunDriver` construction closes over twenty-five deps
  // built in this constructor, so the driver factory is a closure here and
  // nowhere else; `startNew`, `resumeExisting`, `deleteTask`, and
  // `retryPhaseNow` are the four entry points that drive or address a session;
  // and `PhaseControlService`'s three formerly-window-scoped deps
  // (`isDriving`, `noteActivePhaseOverrideAbort`, `armIsContinue`) become
  // queue-addressed seams at their one construction site, which is here. About
  // four fifths of the delta is the recorded reasoning on each — why disposal
  // sits after `drive()` returns rather than in `persistTransition`, why
  // `cancelActive()` keeps an unaddressed form, why a refused resume must still
  // dispose. Raised to exactly what the file measures, per the convention above.
  // Feature 093 (T045-T047) — 902 → 919 as the rest of Phase D's collaborators
  // became queue-addressed. Extraction was measured first and, unlike T042's,
  // nothing came out: the two candidates are `handleUnexpectedStartFailure`
  // (103 lines, twelve collaborators) and `deleteTask` (66 lines, eight), and
  // each is a terminal path carrying an FR-033a `releaseExecutionLeaseForRun`
  // site — `handleUnexpectedStartFailure` carries the `lock.release()` too.
  // Moving either behind a deps object puts hard-rule-bearing code behind an
  // indirection during the very migration that is changing it, which costs more
  // review than the seventeen lines it buys. The delta itself is not a new
  // responsibility: 109 of the 235 added lines are the recorded reasoning the
  // hard rules require at each addressing site, and the code half is +56 net
  // across the whole file — parameter threading and queue-addressed reads, with
  // no cohesive unit hiding inside it. Later phases will move this again;
  // re-measure rather than pre-allocating slack.
  // Feature 093 (T049a) — 919 → 994 for the admission seam: `startNew` and
  // `resumeExisting` each split into a delegating wrapper plus an `admit*` half
  // that returns the drive instead of awaiting it. Extraction was measured and
  // this time something did come out: the four declarations the seam introduces
  // (`RunAdmission`, `ResumeAdmission`, and the two nothing-to-do constants) are
  // a contract between this file and `auto-drain-coordinator.ts` rather than an
  // internal of either, so they now live in `src/controller/run-admission.ts`
  // and are re-exported here for the existing import sites. That is the whole of
  // what is extractable: the remaining delta is four method bodies that must
  // stay on the class because each touches `runFactory`, `store`, `queue` and
  // `sessions` in one transaction, and about two thirds of it is the recorded
  // reasoning on why the seam sits at `markInFlight` — the point after which the
  // rest of a sweep can see the new Run in its capacity counts, and the point
  // CLAUDE.md's lease rule uses to separate the drain's step-7 release from
  // `releaseExecutionLeaseForRun()`, plus the `drainedRunsSettled()` delegation
  // the split makes necessary: `drainQueuedWork` used to answer "that work is
  // over" by accident, and the two moments now need two names. Raised to
  // exactly what the file measures.
  // Feature 093 (T035/T036) — 994 → 1008 for the queue-addressed phase
  // controls. What landed is eight widened public signatures and the private
  // `control()` fold they share. The fold IS the extraction: without it each
  // facade repeats the same resolve-or-refuse preamble, which is eight places
  // for the refusal rule to drift instead of one, and the rule itself already
  // lives off-class in `sole-run-resolver.ts`. The eight facades cannot follow
  // it — they are the controller's public surface, named by `ui-wiring.ts`,
  // `retry-phase-now.ts`, and the sidebar router — so moving them would buy a
  // smaller file with a delegation layer in front of every call site. Raised to
  // exactly what the file measures.
  // Feature 093 (T068b, FR-028) — 1008 → 1023, and the code half is *negative*:
  // two `this.lock.release()` statements deleted and the `lock` parameter
  // property demoted to a plain parameter. The whole delta is recorded
  // reasoning, and it is the kind the hard rules require — CLAUDE.md's lock rule
  // is the one rule in the file that governs two different leases, so a bare
  // deletion at either site reads as "never skip lock release" being violated.
  // Nothing was extracted because nothing was added; re-measuring is the only
  // honest response to a file that shrank in code and grew in explanation.
  // FR-R3-001 — 1023 → 1041 for the envelope backfill in
  // `resumeExistingOnQueue`. The previous ceiling carried four lines of slack
  // over a file that measured 1019, so the +18 here is the 22 lines that landed
  // less that slack. Four lines of code and thirteen of reasoning: a
  // `??`, a log line, and a conditional spread, guarded on the field's absence.
  // It sits inline rather than in a helper because it is the third member of a
  // sequence the function already runs in place — pinned runner, then pipeline,
  // then envelope — and extracting one of three would hide the only property
  // that makes the group legible, which is that each repairs a field a Run
  // created before some feature does not have. The comment is long because the
  // line it guards reads like the thing the feature bans (a queue-row read on a
  // path to execution) and is not; a reader who cannot tell those apart at this
  // seam is a reader who deletes the guard or generalises it.
  // FR-R3-004 — 1041 → 1051 for the mutation ledger's optional dep. Three lines
  // of code — an import, a `Pick<...>` field, and one line handing it to the
  // driver factory — plus seven of reasoning. There is nothing to extract:
  // this file constructs the `RunDriver`, so a dep the driver needs arrives
  // here by definition, and the only alternative to a new field is folding the
  // ledger into the `checkpoints` dep beside it. That was measured and
  // rejected, not skipped: the two answer to different lifetimes — the ledger
  // records at every phase boundary, `checkpoints` only at a Git-capable phase
  // — so a merged dep would make every controller test that wants a checkpoint
  // double supply an observation double as well, and would put the ledger's
  // continuous bracketing behind a name that says it happens before Git.
  // Raised to exactly what the file measures.
  // FR-R3-005 — 1051 → 1066 for the refused-cleanup outcome. Six lines of code
  // — a type import, a local, two assignments off the widened
  // `SessionCleanupOutcome`, and a ternary that omits the field rather than
  // setting it `undefined` — plus nine of contract. Nothing to extract: this
  // method already owns the "queue mutation stands regardless of cleanup"
  // rule, and a refusal is a third answer to the question `sessionCleaned`
  // was asked, not a new question. Folding it into `sessionCleaned: false`
  // was the rejected alternative — it reads as "the evidence is still on
  // disk", when the finding is that the host declined to reach for it — and
  // returning it out-of-band would put the two halves of one outcome on two
  // paths through the same `if`. The doc comments carry the weight because
  // the field is optional in a shape whose other optional field is omitted
  // for an unrelated reason, and a reader who conflates them removes one.
  // Feature FR-R3-008 (T385) — 1,066 → 1,084 for the liveness write. Extraction
  // was measured first and is the larger half of the change: the write rule and
  // all four of its guards moved out, to `recordRunLiveness` in
  // src/controller/run-liveness-recorder.ts, which buys 46 lines (1,130 →
  // 1,084). It went out rather than staying because it needs exactly two of this
  // class's collaborators — `store` and `logger` — which is the same test
  // `execution-lease-release.ts` passed. The pin
  // (`liveness-does-not-touch-transition.test.ts`) still goes through the
  // controller, because that delegating method is the seam the monitor binds to
  // and is therefore what needs guarding against regression.
  // What could not move is 18 lines in three parts. The `getIterationCap` thunk
  // is at the `WorkflowRunFactory` construction site, and that site is here by
  // definition; it reads `options.iterationCap` rather than a live setting, and
  // the six lines above it say why, because the field being frozen at creation is
  // the whole of FR-R3-008's denominator guarantee. The public
  // `recordRunActivity` is a two-line delegation that cannot become an import at
  // its call site: `store` is a private field, and `extension.ts` binds a
  // *method* on the constructed controller. And two imports. Nothing here is a
  // new responsibility — the class already owned "persist a Run record" — so
  // there is no third module hiding in it. Raised to exactly what the file
  // measures.
  //
  // Operator-command extraction ratchet: 1,084 → 963. Same deliberate pass as
  // the `src/extension.ts` entry above, and the same reasoning for taking it
  // outside a feature: the raises are individually correct and cumulatively a
  // ratchet. Two whole methods moved — `deleteTask` to src/controller/
  // task-deletion.ts and `retryPhaseNow` to src/controller/
  // manual-retry-override.ts — leaving a delegation each, plus the inline
  // 21-line return type of the first, which became `TaskDeletionOutcome`
  // alongside it. `SessionCleanupRunner` moved with the deletion path and is
  // re-exported from here, so its one consumer's import path is unchanged.
  // Both qualified for the reason `run-liveness-recorder.ts` did: each is a
  // self-contained transaction over one queue that needs a handful of this
  // class's collaborators and nothing from the drive loop. They were in this
  // class only because that is where the webview command lands.
  // What was deliberately NOT extracted, and should stay put: the two 111-line
  // lifecycle methods, `resumeExistingOnQueue` and `handleUnexpectedStartFailure`.
  // They are the largest remaining blocks and they carry the lease and
  // primacy invariants CLAUDE.md is explicit about; moving the drive core to buy
  // budget is the drive-by refactor the ratchet exists to make unnecessary, not
  // to force. Set to exactly what the file measures.
  //
  // FR-R3-010 — 963 → 973 for the history recorder's two new dependencies,
  // against a ceiling the ratchet above left with nothing to give. No new
  // responsibility: this class already constructed the recorder, and the
  // recorder itself already lived in src/services/history-recorder.ts. What
  // grew is its deps literal. Six of the ten lines say why `queueIdForTask` is
  // `queueIdForExistingTask` and not `queueIdForTask` — the strict resolver
  // that returns `null` rather than falling back to `'default'` — and this
  // construction site is the only place that choice can be got wrong, because
  // the recorder cannot tell a resolved queue from a guessed one. The other
  // four are the `HistoryDescriptionStore`, which needs `options.cwd` and
  // `logger`, both constructor locals.
  // The measured alternative, and why it is not taken here: FR-R3-010 created
  // this same ten-line literal at a second site, in
  // src/activation/run-safety-wiring.ts, and a `createHistoryRecorder()` factory
  // in the module that already owns the class would collapse both. It buys 8 of
  // the 10 — 965 measured, so it does not clear this ceiling on its own — while
  // changing the live wiring of a third file this task does not otherwise
  // touch. Recorded rather than done: it is a consolidation worth making on its
  // own terms, not a budget manoeuvre, and doing it here would mean a raise and
  // a refactor instead of one or the other.
  // Set to exactly what the file measures.
  //
  // Feature 103 (T031) — the consolidation above was taken, and the ceiling
  // holds at 973 rather than rising again. FR-013 added an eleventh line to
  // both copies of the literal, which is the second time one feature has had to
  // edit the same wiring twice; `createHistoryRecorder` in
  // src/services/history-recorder.ts now owns it, and both roots pass their
  // collaborators instead. It buys 9 here (977 → 968) and the same shape at the
  // other site. Not a budget manoeuvre: it is the move this entry named, and it
  // is taken now because this feature is what made the duplication cost
  // something. No ceiling change — a ratchet that only ever loosens is not one.
  { path: 'src/controller/workflow-controller.ts', maxLines: 973 },
  // P4 domain-validator extraction ratchet: 1,200 → 775. The registry owns
  // command coverage; phase-log and metrics validators own shape rules.
  // Feature 088 (T032) — 775 → 776 for the two connected-run commands. Both
  // validators live in validators/workflow-run.ts and neither re-states the
  // nested `RunRequest` shape (it is imported from validators/launch-pipeline.ts,
  // so there is one oracle for it, not three). What landed here is the
  // irreducible registration: two literal imports, one module import, and two
  // switch arms — seven lines for two command families, against a ceiling that
  // had seven to give.
  { path: 'src/contracts/runtime-validators.ts', maxLines: 776 },
  // P4 IPC-family extraction ratchet: 1,250 → 885. The stable barrel retains
  // literals and guards while domain wire shapes live in focused modules.
  // Feature 084 (T071) — 885 → 950 for the process-YAML command family. Its
  // wire shapes already live in sidebar-ipc/process-yaml.ts, so what landed
  // here is only what the ratchet says belongs here: two command literals,
  // their guards, and the COMMAND_TYPES / SidebarCommand / COMMAND_GUARDS
  // entries the drift test requires be exhaustive. There is nothing left to
  // extract, so admitting a new family costs barrel lines by construction.
  // Feature 085 (T068) — 950 → 960. No new family: the two process-YAML guards
  // gained bodies, because 085 made the export payload a discriminated union
  // and emptied the preflight payload, and a guard that ignored either would
  // admit a shape the wire type forbids. Moving them into
  // sidebar-ipc/process-yaml.ts was measured first: that module imports the
  // command literals `import type`, so it erases today, and the guards need
  // them as runtime values — extraction buys ten barrel lines by creating a
  // real import cycle where none exists. The ceiling is raised instead.
  // Feature 087 (T008) — 960 → 975 for the run-launcher family. Its wire
  // shapes and its payload predicate both live in sidebar-ipc/run-launcher.ts;
  // extraction was taken as far as it goes, and the predicate moved out
  // precisely because it needs none of this module's runtime values. What
  // remains is the irreducible five: the command literal, the COMMAND_TYPES
  // entry, the type re-export, the SidebarCommand member, and the COMMAND_GUARDS
  // entry — plus the two-line guard that wraps the extracted predicate with the
  // `isObjectWithType` discriminator check, which 085 established cannot leave
  // this file without creating a real import cycle. Admitting a family costs
  // barrel lines by construction; the ceiling is raised rather than the
  // registration split.
  // Feature 088 (T035) — 975 → 1009 for the connected-run family. Two command
  // literals this time, not one, and the same irreducible five apiece; its wire
  // shapes, its projection, and both payload predicates live in
  // sidebar-ipc/workflow-run.ts. The one line item above the 087 pattern is the
  // type re-export block: the projection travels on the snapshot and on two
  // refusal arms, so the webview needs the names, and re-exporting through the
  // barrel is what every other family here does. Measured after registration,
  // not estimated.
  // Feature 096 (T005) — 1009 → 1024 for `SaveModelsCommand`'s two new optional
  // fields (`expectedRevision`, `mutation`) and their explanatory comment. Not
  // moved to sidebar-ipc/catalog-save.ts beside its Phase/Pipeline/Workflow
  // counterparts: that module's own header says all three share one scoped,
  // revisioned complete-layer envelope, and this command does not — it has no
  // `scope` (the Model Catalog has exactly one writable layer) and both new
  // fields stay optional so the pre-096 unconditional manual-edit call site
  // keeps compiling unmodified. Joining them would misstate the module for a
  // command that does not fit its shape.
  { path: 'src/contracts/sidebar-ipc.ts', maxLines: 1024 },
  // Waived, not budgeted. Feature 063's operator decision retired the ceiling
  // on this file and on queue-manager.ts below; it did not set a large one. The
  // entries used to say `maxLines: 10_000` against files of 2,500 and 1,821,
  // which reads as a budget somebody chose and let either file more than triple
  // while the gate reported success. The decision stands — neither file is
  // forced to extract helpers and neither gains a ceiling here — and FR-R3-027
  // only makes it legible.
  {
    path: 'src/state/workspace-state.ts',
    waiver: {
      decision:
        'per-file caps for queue-manager.ts and workspace-state.ts raised to 10,000 lines; ' +
        'helpers may be extracted for cohesion, but the budget is no longer the forcing function',
      decidedOn: '2026-05-22',
      reference: 'specs/063-clean-all-confirmations/plan.md',
      // FR-R3-055 / H-06 (2026-08-24) — 2513 → 2554 for the fence carried to the
      // Run commit point: the optional claim on `setRun`, and the verify moved
      // INSIDE the `KEYS.run` serialize chain so verify-and-write are one link
      // rather than two operations. It has to be in this file because the commit
      // point is, and the whole finding is that the check was not at the commit
      // point. The protocol and its rationale are in
      // docs/architecture/workspace-ownership-fencing.md.
      highWaterMark: 2554
    }
  },
  // Feature 077 — public facade and every state-projection collaborator have
  // hard physical-LOC ceilings. Composition, lifecycle, and timing are split.
  { path: 'src/ui/sidebar/state-projector.ts', maxLines: 250 },
  { path: 'src/ui/sidebar/state-projector-runtime.ts', maxLines: 300 },
  { path: 'src/ui/sidebar/projector-bookkeeping.ts', maxLines: 300 },
  // Feature 087 (T064) — 300 → 301 for the recorded-run-outputs projection
  // (FR-043). The composition itself was extracted first, to
  // `projectRunOutputs` in run-projector.ts; what landed here is the one thing
  // that cannot leave — a call site in the returned object and its name in the
  // existing run-projector import. Packing that import list would have bought
  // the line back while hiding the growth, so the ceiling is raised in the open
  // instead, matching the justified bumps above. Raised to exactly what the
  // file now measures, not to a round number with slack: an unearned ceiling
  // is a budget that has stopped being a forcing function. Recorded as a plan
  // deviation under specs/087-pipeline-run-composition/tasks.md T068.
  // Feature 088 (T039) — 301 → 302 for the connected-run projection. The same
  // shape as the bump above, and for the same reason: the fold lives in
  // connected-run-projector.ts (which also answers the continuation handler's
  // gate 4, so there is one oracle rather than two), and what landed here is
  // the single conditional spread that cannot live anywhere else. The file was
  // measured at exactly 301 before the edit — the note on T039 said zero slack
  // and it was right — so there was no line to absorb it into short of
  // reflowing unrelated code, which would hide the growth rather than record
  // it. Raised to exactly what the file now measures, per D7.
  // Feature 098 residual (FR-008) — 302 → 308, and every one of the six lines
  // is comment. The code half is a *deletion*: the projection read
  // `run.pipeline && run.pipeline.id !== 'standard'`, suppressing the name of
  // any Run whose Pipeline happened to be called that. It was defensible while
  // `standard` was a built-in id whose name told the operator nothing they had
  // not already been shown; with the catalog runtime-only, `standard` is
  // whatever an operator called a document they imported, and hiding its name
  // hides theirs. The comment stays at the site because the deleted condition
  // is the kind a reader re-adds — a blank header on one Pipeline looks like a
  // projection bug, and the id it keyed on is still a plausible-looking
  // built-in. Trimming it to fit was measured and does not: at two lines the
  // file still reads 304. Nothing was extracted because nothing was added, and
  // the alternative to recording this is a ceiling that quietly absorbs
  // explanation, which is the opposite of what the entries above are for. Set
  // to exactly what the file measures.
  { path: 'src/ui/sidebar/snapshot-composer.ts', maxLines: 308 },
  // The second file of the same 2026-05-22 decision; see the waiver above.
  {
    path: 'src/queue/queue-manager.ts',
    waiver: {
      decision:
        'per-file caps for queue-manager.ts and workspace-state.ts raised to 10,000 lines; ' +
        'helpers may be extracted for cohesion, but the budget is no longer the forcing function',
      decidedOn: '2026-05-22',
      reference: 'specs/063-clean-all-confirmations/plan.md',
      highWaterMark: 1821
    }
  },
  // Speckit-auto alignment (2026-07-30) — bumped 700 → 800 to absorb two new
  // built-in phases (speckit-checklist, speckit-review) and enriched
  // skill-aligned instruction text for clarify, analyze, review, and finalize.
  // Feature 074 — bumped 800 → 850 for runner field on PhaseDef, ALLOWED_PHASE_FIELDS,
  // isPhaseDef runner check, and validatePhaseRaw runner validation.
  { path: 'src/config/pipeline-config.ts', maxLines: 900 },
  // `retry.forceContinueOnCap` (2026-08-16) — 650 → 660 for the retry-cap
  // force-continue default. Extraction was considered and rejected on shape,
  // not on cost: every line added is a row in a declaration this file exists to
  // be — the typed field, its entry in `scopes`, its member of the `AllowedKey`
  // union, and its `KEY_SPECS` spec. Moving one key's rows out would split a
  // single table across two files so that the table could stay under a ceiling,
  // which hides the growth rather than recording it. Raised to exactly what the
  // file now measures, not to a round number with slack, per the note on
  // snapshot-composer.ts above.
  //
  // FR-R3-051 / M-05 (2026-08-24) — 660 → 698 for the manifest scope becoming a
  // declared, required field on every spec, one resolver from scope to
  // configuration target, and the rollback capture/restore pair becoming
  // scope-aware. Same shape as the note above: `scope` is a new column in the
  // table this file exists to be, so extraction would split one declaration
  // across two files to keep a ceiling. The prose that justified the change was
  // moved OUT, to
  // specs/136-settings-scope-and-defaults/contracts/settings-write-target.md,
  // before raising — the budget buys the note, not the explanation.
  { path: 'src/config/general-settings.ts', maxLines: 698 }
];

function lineCount(path: string): number {
  const contents = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  return contents.length === 0 ? 0 : contents.split(/\r?\n/).length;
}

describe('large source file LOC budgets', () => {
  for (const budget of BUDGETS) {
    if (isWaived(budget)) continue;
    it(`${budget.path} stays at or below ${budget.maxLines} lines`, () => {
      const actual = lineCount(budget.path);
      expect(
        actual,
        `${budget.path} has ${actual} lines, over budget ${budget.maxLines}; split new responsibilities into focused modules before adding more behavior`
      ).toBeLessThanOrEqual(budget.maxLines);
    });
  }

  // The guard the notation change exists for: an entry whose ceiling is a large
  // multiple of its file is a waiver, and a waiver has to say so. Without this,
  // a third entry can quietly acquire the shape the two waived ones had.
  it(`every ceiling within ${WAIVER_FACTOR}x its file, or declared a waiver`, () => {
    const offenders = BUDGETS.filter((entry): entry is CeilingEntry => !isWaived(entry))
      .map((entry) => ({ ...entry, actual: lineCount(entry.path) }))
      .filter((entry) => entry.maxLines > entry.actual * WAIVER_FACTOR)
      .map(
        (entry) =>
          `${entry.path}: budget ${entry.maxLines} against ${entry.actual} measured lines ` +
          `(${(entry.maxLines / entry.actual).toFixed(2)}x). Either tighten the ceiling to ` +
          `what the file measures, or replace maxLines with a waiver naming the decision ` +
          `that retired it — a ceiling this far above the file has stopped being a forcing function`
      );
    expect(offenders).toEqual([]);
  });

  // A waiver is a decision on the record, so the record has to be reachable.
  // Growth on a waived file is reported rather than gated: the decision retired
  // the ceiling, and hiding the size would be a second silence on top of it.
  it('every waiver names a resolvable decision, and its file size is reported', () => {
    const waived = BUDGETS.filter(isWaived);
    expect(waived.length, 'the waiver path must stay exercised').toBeGreaterThan(0);

    const malformed = waived
      .filter(
        (entry) =>
          entry.waiver.decision.trim().length < 20 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(entry.waiver.decidedOn) ||
          !existsSync(resolve(ENVELOPE_ROOT, entry.waiver.reference))
      )
      .map(
        (entry) =>
          `${entry.path}: waiver needs a quoted decision, an ISO date, and a reference that ` +
          `resolves on disk (got "${entry.waiver.reference}")`
      );
    expect(malformed).toEqual([]);

    const sizes = waived
      .map((entry) => `${entry.path} ${lineCount(entry.path)}/${entry.waiver.highWaterMark} lines`)
      .join('; ');
    console.log(`LOC waivers (ratcheted, no ceiling): ${sizes}`);
  });

  // STATE-1 from the 2026-08-22 review: "a waiver that removed the forcing
  // function without replacing it". This is the replacement, and it is
  // deliberately not the thing the decision retired — see `highWaterMark`.
  it('no waived file grows past its recorded high-water mark', () => {
    const grown = BUDGETS.filter(isWaived)
      .map((entry) => ({ entry, actual: lineCount(entry.path) }))
      .filter(({ entry, actual }) => actual > entry.waiver.highWaterMark)
      .map(
        ({ entry, actual }) =>
          `${entry.path}: ${actual} lines, past its mark of ${entry.waiver.highWaterMark} ` +
          `(+${actual - entry.waiver.highWaterMark})`
      );
    expect(
      grown,
      `A waived file grew:\n  ${grown.join('\n  ')}\n\n` +
        `The waiver retired the ceiling, not the forcing function. Either keep the ` +
        `addition size-neutral, extract the new behaviour into its own module, or raise ` +
        `the mark in this file and say why in the commit — the point is that growing ` +
        `these two takes a decision rather than happening quietly.`
    ).toEqual([]);
  });

  it('a high-water mark comes down when the file does', () => {
    // Ratchets only ratchet if they tighten. A mark left far above a file that
    // has shrunk is headroom nobody granted, and it re-creates the gap this
    // replaced — slowly, and with the gate reporting success throughout.
    const slack = BUDGETS.filter(isWaived)
      .map((entry) => ({ entry, actual: lineCount(entry.path) }))
      .filter(({ entry, actual }) => entry.waiver.highWaterMark - actual > RATCHET_SLACK)
      .map(
        ({ entry, actual }) =>
          `${entry.path}: mark ${entry.waiver.highWaterMark}, file ${actual} ` +
          `(${entry.waiver.highWaterMark - actual} lines of unclaimed headroom)`
      );
    expect(
      slack,
      `These marks are stale and should be lowered to the file's current size:\n  ` +
        slack.join('\n  ') +
        `\n\nA mark more than ${RATCHET_SLACK} lines above its file has stopped ` +
        `ratcheting and started granting room.`
    ).toEqual([]);
  });

  it('every sidebar projector module stays at or below 300 lines', () => {
    const directory = resolve(REPO_ROOT, 'src/ui/sidebar');
    const modules = readdirSync(directory)
      .filter((name) => name.includes('projector') && name.endsWith('.ts'));
    const offenders = modules
      .map((name) => ({ name, lines: lineCount(`src/ui/sidebar/${name}`) }))
      .filter(({ lines }) => lines > 300);
    expect(offenders).toEqual([]);
  });
});
