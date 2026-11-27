// Feature 318 (FR-R7-04, FR-006, SC-006) — operator observe-and-revoke surface
// for per-workspace repository agent configuration acknowledgements.
//
// Modelled directly on `src/commands/git-approvals.ts`:
//   - Zero `vscode` imports; QuickPick, confirmation modal, and info notifier
//     are injected so every branch is unit-testable without an Extension Host.
//   - Picking a row selects; only the confirmation modal's affirmative label
//     withdraws a grant.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { AgentConfigGrantFileSummary } from '../state/agent-config-grants';

export interface AgentConfigAckItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  /** `null` marks the "Forget All Acknowledgements" sentinel row. */
  readonly fingerprint: string | null;
}

export interface AgentConfigAckRecord {
  readonly fingerprint: string;
  readonly backend: BackendRunnerKind;
  readonly grantedAt: number;
  readonly files: readonly AgentConfigGrantFileSummary[];
}

export interface AgentConfigAcknowledgementsDeps {
  /** Live map read when the command runs; never captured at wiring time. */
  readonly grants: () => Readonly<Record<string, AgentConfigAckRecord>>;
  readonly forget: (fingerprint: string) => Promise<boolean>;
  readonly forgetAll: () => Promise<number>;
  readonly pick: (items: readonly AgentConfigAckItem[]) => Promise<AgentConfigAckItem | undefined>;
  readonly confirm: (
    message: string,
    detail: string,
    approveLabel: string
  ) => Promise<string | undefined>;
  readonly info: (message: string) => void;
}

export const FORGET_ONE_ACK_LABEL = 'Forget This Acknowledgement';
export const FORGET_ALL_ACKS_LABEL = 'Forget All Acknowledgements';

export const NO_AGENT_CONFIG_ACKS_MESSAGE =
  'Schegent: no repository agent configuration acknowledgements are stored for this workspace. ' +
  'Choosing "Acknowledge for This Workspace" before an uncontained run stores one.';

function renderGrantedAt(grantedAt: number): string {
  const at = new Date(grantedAt);
  return Number.isFinite(at.getTime())
    ? `acknowledged ${at.toLocaleString()}`
    : 'acknowledged at an unreadable time';
}

export function buildAgentConfigAckItems(
  grants: Readonly<Record<string, AgentConfigAckRecord>>
): readonly AgentConfigAckItem[] {
  const entries = Object.values(grants).sort(
    (a, b) => b.grantedAt - a.grantedAt || b.fingerprint.localeCompare(a.fingerprint)
  );
  const rows: AgentConfigAckItem[] = entries.map((grant) => {
    const fileList = grant.files
      .map((file) => `${file.name} (${file.digest.slice(0, 12)})`)
      .join(', ');
    const noun = grant.files.length === 1 ? 'file' : 'files';
    return {
      label: `${grant.backend} (${grant.files.length} ${noun})`,
      description: renderGrantedAt(grant.grantedAt),
      detail: `Files: ${fileList} · digest set ${grant.fingerprint.slice(0, 16)}`,
      fingerprint: grant.fingerprint
    };
  });

  if (rows.length > 1) {
    rows.push({
      label: FORGET_ALL_ACKS_LABEL,
      description: `${rows.length} acknowledgements`,
      detail:
        'Every repository agent configuration acknowledgement stored for this workspace. ' +
        'Each uncontained run with repository config will ask again.',
      fingerprint: null
    });
  }
  return rows;
}

export async function runAgentConfigAcknowledgements(
  deps: AgentConfigAcknowledgementsDeps
): Promise<void> {
  const items = buildAgentConfigAckItems(deps.grants());
  if (items.length === 0) {
    deps.info(NO_AGENT_CONFIG_ACKS_MESSAGE);
    return;
  }

  const chosen = await deps.pick(items);
  if (chosen === undefined) return;

  if (chosen.fingerprint === null) {
    const approved = await deps.confirm(
      'Forget every repository agent configuration acknowledgement stored for this workspace?',
      'The next uncontained run will scan repository agent configuration and ask again. ' +
        'Nothing else in this workspace changes.',
      FORGET_ALL_ACKS_LABEL
    );
    if (approved !== FORGET_ALL_ACKS_LABEL) return;
    const count = await deps.forgetAll();
    deps.info(
      `Schegent: forgot ${count} repository agent configuration acknowledgement${count === 1 ? '' : 's'}. ` +
        'The next uncontained run will ask again.'
    );
    return;
  }

  const approved = await deps.confirm(
    `Forget the repository agent configuration acknowledgement for '${chosen.label}'?`,
    `${chosen.detail}\n\nThe next uncontained run will ask again. No other acknowledgement changes.`,
    FORGET_ONE_ACK_LABEL
  );
  if (approved !== FORGET_ONE_ACK_LABEL) return;

  const removed = await deps.forget(chosen.fingerprint);
  deps.info(
    removed
      ? `Schegent: forgot the repository agent configuration acknowledgement for '${chosen.label}'. The next uncontained run will ask again.`
      : `Schegent: that repository agent configuration acknowledgement was already gone — nothing to forget for '${chosen.label}'.`
  );
}
