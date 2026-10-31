// FR-R3-136 (FR-002, FR-003, FR-004) — the disposition of every direct VS Code
// command entry point.
//
// WHY THIS FILE EXISTS. `COMMAND_AUTHORITY` in
// `./sidebar-command-metadata.ts` has classified the sidebar's IPC surface since
// Feature 059 (as a partial reason table, total since FR-R4-F05), and
// `src/ui/sidebar/message-router.ts` refuses every gated command in it
// while the workspace is untrusted. That works, and it covers one of the two ways
// to reach a mutating service. The other is `vscode.commands.executeCommand`, and
// it had no classification at all: `src/activation/ui-wiring.ts` registered 29
// commands and `src/extension.ts` one more, none of them consulting trust, and
// `docs/reference/api-and-cli.md` recorded the gap for six of them in prose
// ("no direct trust/primacy check") without closing it.
//
// So this is the sibling map for the command surface, deliberately shaped like the
// sidebar one: an id to a REASON, not to a boolean. The reason is what a refusal
// message, an audit line and a lint failure all get to name, and the sidebar half
// has already proved that is worth more than a flag.
//
// TWO MAPS RATHER THAN ONE MAP TO AN ENUM. The union of their keys is what
// `tests/lint/command-trust-dispositions.test.ts` reconciles against the manifest
// and against the registration sites. With one map to an enum, an id could be
// present-but-unclassified; with two, absence from both is the only failure mode,
// and it is the one the gate and `registerGuardedCommand` both catch.
//
// THE CRITERION (spec C3 as narrowed by C7): a mutating entry writes to a path the
// workspace or persisted state can influence, spawns a child process, or arms a
// timer. Writing to a destination the operator confirms in a modal is NOT such a
// path, because no repository content can confirm a modal. Three of the
// rows below come out opposite to what their names suggest, and each says why.

/**
 * Entries that can cause an effect. Refused in an untrusted window, at the point
 * of effect rather than at registration (FR-005).
 */
export const MUTATING_COMMAND_IDS = Object.freeze({
  'schegent.reset': 'workspace state reset',
  'schegent.auto': 'workflow start',
  'schegent.enqueue': 'queue enqueue',
  'schegent.schedule': 'scheduled start write',
  'schegent.resume': 'workflow resume',
  'schegent.startQueue': 'queue start',
  'schegent.cancel': 'workflow cancellation',
  'schegent.restartCanceledTask': 'canceled task restart',
  'schegent.retryQueuedItem': 'queue item retry',
  // Feature 195 (T064, FR-025) — the third exit from a halted queue, beside the
  // retry above and removal. Registered-only (no `package.json` entry), same
  // shape as `schegent.clearQueue` and `schegent.setQueueFailurePolicy` below:
  // called from `cmd-attest-task-completed.ts`'s sidebar handler alone, because
  // the assertion is about one named task the operator is looking at and a
  // palette entry would offer it with no row in front of it.
  'schegent.attestTaskCompleted': 'attested task completion',
  'schegent.moveQueuedItemUp': 'queue reorder',
  'schegent.moveQueuedItemDown': 'queue reorder',
  'schegent.clearAll': 'queue full reset',
  // FR-R3-150 (T1620) — the queue-scoped Clean All's own VS Code command,
  // registered-only (no `package.json` entry) and called from
  // `cmd-clear-queue.ts`'s sidebar handler alone.
  'schegent.clearQueue': 'queue reset',
  'schegent.clearCompleted': 'queue cleanup',
  'schegent.clearFailed': 'queue cleanup',
  'schegent.pauseQueue': 'queue pause state',
  'schegent.resumeQueue': 'queue pause state',
  // Feature 195 (T037, FR-018, FR-019) — this queue's own halt-on-failure
  // answer, or its removal. Registered-only (no `package.json` entry), same
  // shape as `schegent.clearQueue` above: called from
  // `cmd-set-queue-failure-policy.ts`'s sidebar handler alone.
  'schegent.setQueueFailurePolicy': 'queue failure-policy write',
  'schegent.rerunFromHistory': 'queue enqueue from history',
  'schegent.retryActiveRun': 'active run retry',
  'schegent.retryPhaseNow': 'phase retry',
  'schegent.pausePhase': 'phase pause',
  'schegent.resumePhase': 'phase resume',
  'schegent.restartPhase': 'phase restart',
  'schegent.deleteRunEvidence': 'evidence deletion',

  // FR-R3-146 (FR-012) — LISTS grants and can withdraw them, so it is classified
  // by the second half. The criterion above asks whether an entry can cause an
  // effect, not what its name suggests, and withdrawing a consent decision writes
  // persisted state.
  //
  // Refused while untrusted despite being the safe direction — withdrawal only
  // ever makes the product ask MORE — because the read half is what the refusal
  // would also cost, and an untrusted window is one where repository content may
  // have influenced what is on screen. The operator loses nothing that trusting
  // the folder does not immediately return, and `schegent.reset` is classified the
  // same way for the same reason.
  'schegent.gitApprovals': 'git approval withdrawal',

  // FR-R4-F03 (FR-017) — writes the audit head checkpoint outside the workspace, retiring it. Mutating
  // and owner-only, and it refuses while any audit file is present: it never deletes or moves evidence.
  'schegent.resetAuditCheckpoint': 'retires the audit head checkpoint',

  // FR-R4-F04 (FR-020, E10, R24) — the two exports. They were read-only under FR-R3-136's C7, on the
  // argument that the destination comes from a modal no workspace content can answer, and that stays
  // true. What changed is that each export now RECORDS itself in the audit log, and a window that does
  // not own the workspace cannot write that row (the audit writer throws `audit-not-owner` there), so an
  // export from an untrusted or secondary window could never be recorded. Reversing that choice is the
  // price of FR-020 ("every export is one audit row"): the exports are mutating, owner-only commands.
  'schegent.exportAuditLog': 'audit export, recorded in the audit log',
  'schegent.exportRunEvidence': 'evidence export, recorded in the audit log',

  // FR-R4-F04 (FR-028) — replaces the operator pseudonym, and records that it did. Mutating and
  // owner-only: an untrusted window refuses it, and a window that does not own the workspace has no owner
  // to write the row.
  'schegent.resetOperatorPseudonym': 'operator pseudonym reset, recorded in the audit log',

  // FR-R4-F04 (FR-034, R34) — builds a diagnostics bundle for one Run and records that it did, like the
  // two exports above: mutating and owner-only, for the same reason (the row needs an owner to write it).
  'schegent.createDiagnosticsBundle': 'diagnostics bundle, recorded in the audit log'
} as const);

/**
 * Entries the manifest's `limited` claim promises stay usable while untrusted:
 * state, history, audit and log reads. Registered unwrapped, so the read path
 * pays nothing for the guard.
 */
export const READ_ONLY_COMMAND_IDS = Object.freeze({
  'schegent.showAuditLog': 'audit read',
  'schegent.showActiveRun': 'active run read',
  'schegent.openDashboard': 'dashboard view',

  // A read, and it stays one. Its two arms, `onBreak` and `onLoss`, report to the operator and set
  // the audit sink's health (`noteChainBreak`, `noteHistoryLoss`); neither writes a file, and neither
  // is a producer act. (An earlier version of this note said a detected break appended to the audit
  // log. It never did: the writer's only append path is a step that asks who owns the workspace.)
  //
  // The audit writer is constructed in every window and writes only as the owner, behind the
  // authority port (`audit-write-authority.ts`), so verification still runs, and still tells the
  // truth, in an untrusted or non-owner window: strictly better than refusing the one read an
  // operator most wants while looking at a repository they have not trusted.
  'schegent.verifyAuditChain': 'audit chain read',

  // Looks like it probes the filesystem for an executable, and no longer does.
  // `ui-wiring.ts` reduced it to a single `notifier.info` when the Claude CLI
  // gained native stdin streaming. It spawns nothing and touches nothing. If it
  // ever regains a probe it moves to the map above; the gate cannot catch that,
  // which is why the reason names the body rather than the intent.
  'schegent.redetectClaudeTransport': 'notification only',

  // FR-R4-F04 — `schegent.exportAuditLog` and `schegent.exportRunEvidence` were here, read-only under
  // FR-R3-136's C7 (the destination comes from a modal no workspace content can answer). They record an
  // audit row now and so moved to `MUTATING_COMMAND_IDS` above, owner-only.

  // FR-R4-F16 (feature 244) — reads the audit chain and the queue state and opens an unsaved Markdown
  // document. It is given no audit writer, queue manager, controller or lock (`failedRowCensusPorts`),
  // so it appends nothing and starts nothing, and what it opens carries only counts, closed tokens and
  // ids that pass their patterns: no title, error text, actor or path from the workspace.
  'schegent.reportFailedRowExits': 'failed-row census read'
} as const);

export type MutatingCommandId = keyof typeof MUTATING_COMMAND_IDS;
export type ReadOnlyCommandId = keyof typeof READ_ONLY_COMMAND_IDS;

/**
 * Every id this extension registers. `registerGuardedCommand` accepts nothing
 * else, so an id missing from both maps above is a COMPILE error at the
 * registration site — the runtime throw is the second line of defence, for a cast
 * or a dynamically built id.
 */
export type ExtensionCommandId = MutatingCommandId | ReadOnlyCommandId;

/**
 * FR-R4-F03 (FR-011; data-model §9, R11, contract O3) — the mutating commands that START or RECORD
 * work, and so write audit evidence: in a window that does not own the workspace they refuse, before
 * anything runs. `registerGuardedCommand` checks trust first (unchanged) and then asks the owner
 * predicate, and throws at registration when an id of this set arrives without one, as it does for
 * an unclassified id.
 *
 * Every key is also a key of `MUTATING_COMMAND_IDS` (a lint case holds that), and the type below
 * makes an id that is not an extension command a compile error. The reasons are the operator's
 * words for why the action belongs to the owner.
 */
export const OWNER_ONLY_COMMAND_IDS = Object.freeze({
  'schegent.startQueue': 'starts a Run that records audit evidence',
  'schegent.restartCanceledTask': 'starts a Run that records audit evidence',
  'schegent.cancel': 'records the cancellation',
  'schegent.reset': 'records the workspace reset',
  'schegent.pausePhase': 'records the phase control',
  'schegent.resumePhase': 'records the phase control',
  'schegent.restartPhase': 'records the phase control',
  'schegent.deleteRunEvidence': 'records the deletion',
  'schegent.resetAuditCheckpoint': 'retires the audit head checkpoint',
  'schegent.exportRunEvidence': 'records the export',
  'schegent.exportAuditLog': 'records the export',
  'schegent.resetOperatorPseudonym': 'records the reset',
  'schegent.createDiagnosticsBundle': 'records the export'
} as const satisfies Partial<Record<ExtensionCommandId, string>>);

export type OwnerOnlyCommandId = keyof typeof OWNER_ONLY_COMMAND_IDS;

export type EntryDisposition = 'mutating' | 'read-only';

export const MUTATING_COMMAND_ID_LIST: readonly MutatingCommandId[] = Object.freeze(
  Object.keys(MUTATING_COMMAND_IDS) as MutatingCommandId[]
);

export const READ_ONLY_COMMAND_ID_LIST: readonly ReadOnlyCommandId[] = Object.freeze(
  Object.keys(READ_ONLY_COMMAND_IDS) as ReadOnlyCommandId[]
);

/**
 * The disposition and reason for a command id, or `null` when the id is in
 * neither map.
 *
 * Returning `null` rather than defaulting to `'mutating'` is deliberate. FR-003
 * requires omission to fail closed, and the two callers fail closed in the two
 * ways that are actually useful: `registerGuardedCommand` throws so activation
 * breaks in a test, and the lint gate reports the unclassified id by name. A
 * silent default to `'mutating'` would satisfy the letter of "fail closed" while
 * letting an unclassified command ship as a mystery refusal.
 */
export interface DispositionEntry {
  readonly disposition: EntryDisposition;
  readonly reason: string;
}

/**
 * Thrown when an id reaches registration with no declared disposition.
 *
 * A named class rather than a bare `Error` so a test can assert the mechanism
 * fires for the right reason instead of matching on message prose — the same
 * argument `gate-recorder.mjs` makes for its `reason` field.
 *
 * IT LIVES HERE, NOT BESIDE `registerGuardedCommand`, and that placement is
 * load-bearing. `tests/lint/command-trust-dispositions.test.ts` must be able to
 * drive the throw as its non-vacuity control, and `FR-R3-126` established the rule
 * it would break by importing the registration module to do so: "a gate whose
 * dependency graph reaches `vscode` can fail for reasons that have nothing to do
 * with what it checks." The registration helper imports `vscode`; this module
 * imports nothing at all.
 */
export class UnclassifiedCommandError extends Error {
  public readonly commandId: string;

  constructor(commandId: string) {
    super(
      `Schegent: refusing to register "${commandId}" — it has no entry in ` +
        'MUTATING_COMMAND_IDS or READ_ONLY_COMMAND_IDS. Classify it in ' +
        'src/contracts/entry-point-dispositions.ts (FR-R3-136, FR-003).'
    );
    this.name = 'UnclassifiedCommandError';
    this.commandId = commandId;
  }
}

/**
 * The disposition for an id, or a throw. The registration path's entry point.
 *
 * Throwing at registration rather than returning a refusing handler is deliberate:
 * a mis-registered command must break activation where a test can see it, not
 * become a silently inert palette entry in production.
 */
export function requireDisposition(id: string): DispositionEntry {
  const entry = lookupDisposition(id);
  if (entry === null) throw new UnclassifiedCommandError(id);
  return entry;
}

export function lookupDisposition(
  id: string
): { readonly disposition: EntryDisposition; readonly reason: string } | null {
  if (Object.prototype.hasOwnProperty.call(MUTATING_COMMAND_IDS, id)) {
    return {
      disposition: 'mutating',
      reason: MUTATING_COMMAND_IDS[id as MutatingCommandId]
    };
  }
  if (Object.prototype.hasOwnProperty.call(READ_ONLY_COMMAND_IDS, id)) {
    return {
      disposition: 'read-only',
      reason: READ_ONLY_COMMAND_IDS[id as ReadOnlyCommandId]
    };
  }
  return null;
}
