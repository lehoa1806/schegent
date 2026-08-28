// FR-R3-136 (FR-002, FR-003, FR-004) — the disposition of every direct VS Code
// command entry point.
//
// WHY THIS FILE EXISTS. `MUTATING_COMMAND_REASONS` in
// `./sidebar-command-metadata.ts` has classified the sidebar's IPC surface since
// Feature 059, and `src/ui/sidebar/message-router.ts` refuses every member of it
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
// path, because no repository content can confirm a modal. Three of the thirty
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
  'schegent.moveQueuedItemUp': 'queue reorder',
  'schegent.moveQueuedItemDown': 'queue reorder',
  'schegent.clearAll': 'queue full reset',
  'schegent.clearCompleted': 'queue cleanup',
  'schegent.clearFailed': 'queue cleanup',
  'schegent.pauseQueue': 'queue pause state',
  'schegent.resumeQueue': 'queue pause state',
  'schegent.rerunFromHistory': 'queue enqueue from history',
  'schegent.retryActiveRun': 'active run retry',
  'schegent.retryPhaseNow': 'phase retry',
  'schegent.pausePhase': 'phase pause',
  'schegent.resumePhase': 'phase resume',
  'schegent.restartPhase': 'phase restart',
  'schegent.deleteRunEvidence': 'evidence deletion'
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

  // Looks like a pure read and is not, quite. `ui-wiring.ts` passes
  // `onBreak: (detail) => deps.auditWriter.noteChainBreak(detail)`, so a DETECTED
  // BREAK appends to the audit log — a workspace-controlled path, and mutating by
  // the criterion above.
  //
  // Classified read-only anyway, because the right fix is to suppress the arm and
  // not the command. The audit writer is a producer, so while untrusted it is
  // absent and `onBreak` reports to the operator without appending. Verification
  // therefore still runs and still tells the truth in an untrusted window, which
  // is strictly better than refusing an operator the one read they most want while
  // looking at a repository they have not trusted.
  'schegent.verifyAuditChain': 'audit chain read',

  // Looks like it probes the filesystem for an executable, and no longer does.
  // `ui-wiring.ts` reduced it to a single `notifier.info` when the Claude CLI
  // gained native stdin streaming. It spawns nothing and touches nothing. If it
  // ever regains a probe it moves to the map above; the gate cannot catch that,
  // which is why the reason names the body rather than the intent.
  'schegent.redetectClaudeTransport': 'notification only',

  // Both write a file, and both stay read-only under C7: the destination comes
  // from a modal the operator confirms — `vscode.window.showSaveDialog` for the
  // audit export, an injected `promptForDestination()` for the evidence export —
  // and no workspace content can confirm a modal or choose that path. The
  // evidence export additionally refuses any destination inside `.schegent/`,
  // which is the only path the workspace does control.
  'schegent.exportAuditLog': 'audit export to an operator-confirmed destination',
  'schegent.exportRunEvidence': 'evidence export to an operator-confirmed destination'
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
