// FR-R3-146 (FR-012, SC-005) — where an operator sees what they granted, and
// takes it back.
//
// WHY THIS EXISTS. FR-012 says both grants must stay "observable and revocable by
// the operator … and removing either MUST restore the corresponding prompt", and
// SC-005 says that has to be possible "without reading source code". The backend
// grant satisfies both by construction: it IS a setting, so the Settings tab and
// `settings.json` show it and edit it.
//
// The Git grant satisfied neither. It lives in `context.workspaceState`, which
// VS Code keeps in `state.vscdb` — a SQLite database, not a document anyone reads
// or edits by hand. Five surfaces papered over that by naming a
// `.schegent/state.json` that this product has never written, so the ONLY
// documented route to inspect or withdraw a Git grant was a file that does not
// exist. The requirement was not partially met; it was met by a fiction. The
// nearest real thing was `schegent.reset`, which discards all workspace state and
// is not withdrawal of a consent decision, it is amnesia.
//
// So: one command that lists the grants and takes one — or all — back. Not a
// webview, not a new document format, and not a new storage location. The record
// already carries `pipelineId`, `phaseIds` and `grantedAt` precisely so it could
// be READ by an operator (`git-plan-grants.ts:34-45`); it had nowhere to be read.
//
// THE PORTS ARE INJECTED, for the reason `git-approval.ts:24-25` and
// `uncontained-consent.ts:38-40` both give: the decision has to be testable
// without a VS Code host. Nothing here imports `vscode`.

/** One line the operator can act on, and the fingerprint it belongs to. */
export interface GitApprovalItem {
  /** What the QuickPick shows first: the pipeline they approved. */
  readonly label: string;
  /** When they approved it. */
  readonly description: string;
  /** The phases the grant covers, and the plan it is keyed by. */
  readonly detail: string;
  /**
   * Which grant this row is. `null` marks the "forget all" row, which is not a
   * grant — a sentinel rather than a magic fingerprint string, so no stored key
   * can ever collide with it.
   */
  readonly fingerprint: string | null;
}

/** The grant as this module needs to read it; a structural subset of `GitPlanGrant`. */
export interface GitApprovalRecord {
  readonly fingerprint: string;
  readonly grantedAt: number;
  readonly phaseIds: readonly string[];
  readonly pipelineId: string;
}

export interface GitApprovalsDeps {
  /** The live map, read when the command runs. Never captured at wiring time. */
  readonly grants: () => Readonly<Record<string, GitApprovalRecord>>;
  readonly forget: (fingerprint: string) => Promise<boolean>;
  readonly forgetAll: () => Promise<number>;
  /** Resolves to the chosen item, or `undefined` when the operator dismissed. */
  readonly pick: (items: readonly GitApprovalItem[]) => Promise<GitApprovalItem | undefined>;
  /** Resolves to the chosen action label, or `undefined` on cancel/dismissal. */
  readonly confirm: (
    message: string,
    detail: string,
    approveLabel: string
  ) => Promise<string | undefined>;
  readonly info: (message: string) => void;
}

/** The affirmative action on the withdrawal confirmation. Anything else keeps the grant. */
export const FORGET_ONE_LABEL = 'Forget This Approval';
export const FORGET_ALL_LABEL = 'Forget All Approvals';

/**
 * What the operator is told when there is nothing stored.
 *
 * It names the action that creates one, because "no approvals" and "this feature
 * is not working" look identical to someone who just pressed the button.
 */
export const NO_APPROVALS_MESSAGE =
  'Schegent: no Git approvals are stored for this workspace. ' +
  'Choosing "Always Approve This Plan Here" in a Git approval prompt is what stores one.';

/**
 * When the grant was made, as an operator can read it.
 *
 * A locale string, not ISO-8601: this is the one field whose whole purpose is to
 * be legible to a person, and `2026-08-31T09:14:22.000Z` answers "is this the one
 * I made this morning" worse than the machine's own format does. The record keeps
 * epoch milliseconds; only this rendering is local.
 */
function renderGrantedAt(grantedAt: number): string {
  const at = new Date(grantedAt);
  return Number.isFinite(at.getTime()) ? `granted ${at.toLocaleString()}` : 'granted at an unreadable time';
}

/**
 * The rows, newest first.
 *
 * Newest first because the grant an operator is looking for is almost always the
 * one they just made — the case where they approved something and immediately
 * wanted to check what it covered.
 */
export function buildGitApprovalItems(
  grants: Readonly<Record<string, GitApprovalRecord>>
): readonly GitApprovalItem[] {
  const entries = Object.values(grants).sort((a, b) => b.grantedAt - a.grantedAt);
  const rows: GitApprovalItem[] = entries.map((grant) => ({
    label: grant.pipelineId,
    description: renderGrantedAt(grant.grantedAt),
    // Both bounds of the grant, in the row itself: WHICH phases may change Git
    // state, and WHICH plan the approval is keyed by. The fingerprint is what
    // makes two rows for the same pipeline distinguishable after an edit, which
    // is exactly the case FR-008 creates.
    detail:
      `Git-capable phases: ${grant.phaseIds.length > 0 ? grant.phaseIds.join(', ') : 'none recorded'}` +
      ` · plan ${grant.fingerprint}`,
    fingerprint: grant.fingerprint
  }));

  if (rows.length > 1) {
    rows.push({
      label: FORGET_ALL_LABEL,
      description: `${rows.length} approvals`,
      detail: 'Every Git approval stored for this workspace. Each plan asks again on its next run.',
      fingerprint: null
    });
  }
  return rows;
}

/**
 * Show the stored Git approvals; withdraw the one the operator picks.
 *
 * Picking a row is not the withdrawal — the confirmation is. The list is the
 * OBSERVE half of FR-012, and an operator opening it to read what they granted
 * must be able to click a row without destroying it. So the pick selects, the
 * modal decides, and dismissal at either step changes nothing. Same rule as both
 * consent modals: only the explicit affirmative action acts.
 */
export async function runGitApprovals(deps: GitApprovalsDeps): Promise<void> {
  const items = buildGitApprovalItems(deps.grants());
  if (items.length === 0) {
    deps.info(NO_APPROVALS_MESSAGE);
    return;
  }

  const chosen = await deps.pick(items);
  if (chosen === undefined) return;

  if (chosen.fingerprint === null) {
    const approved = await deps.confirm(
      'Forget every Git approval stored for this workspace?',
      'Each approved plan will ask again the next time a run reaches a Git-capable phase. ' +
        'Nothing else in this workspace changes.',
      FORGET_ALL_LABEL
    );
    if (approved !== FORGET_ALL_LABEL) return;
    const count = await deps.forgetAll();
    deps.info(
      `Schegent: forgot ${count} Git approval${count === 1 ? '' : 's'}. ` +
        'The next run on each plan will ask again.'
    );
    return;
  }

  const approved = await deps.confirm(
    `Forget the Git approval for '${chosen.label}'?`,
    `${chosen.detail}\n\nThe next run on this plan will ask again. No other approval changes.`,
    FORGET_ONE_LABEL
  );
  if (approved !== FORGET_ONE_LABEL) return;

  // `forget` reports whether anything was there, and the two outcomes are told
  // apart rather than both reported as success: a list read a while ago can name
  // a grant another window already withdrew, and telling that operator they just
  // forgot it would be a lie about a security decision.
  const removed = await deps.forget(chosen.fingerprint);
  deps.info(
    removed
      ? `Schegent: forgot the Git approval for '${chosen.label}'. The next run on this plan will ask again.`
      : `Schegent: that Git approval was already gone — nothing to forget for '${chosen.label}'.`
  );
}
