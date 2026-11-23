// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Returns a requester. The modal is shown only when an uncontained Run starts,
// and no Run starts in an untrusted window.
//
// Feature 318 (FR-R7-04, FR-004, SC-001, SC-002, SC-003) — operator consent
// modal for repository-controlled agent configuration before an uncontained Run.
//
// Zero `vscode` imports: the blocking dialog is injected via `ModalChoice` (the
// same seam `git-approval.ts` uses) so every branch is unit-testable without an
// Extension Host.
//
// SECURITY INVARIANTS
//   1. Only explicit affirmative labels approve. Cancel, dismissal, any unknown
//      label, or a dialog error resolves to `'denied'`.
//   2. When `!scan.persistable` (any unreadable entry or scan error), the
//      persistent action is NOT offered and `'persist'` can NEVER be returned.
//   3. Modal text contains ONLY fixed relative names, byte sizes, short SHA-256
//      digests, Claude hook event names / execution-relevant key names, and closed
//      reason phrases — never raw configuration values or file contents.
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import type { ModalChoice } from './git-approval';
import type {
  AgentConfigUnreadableReason,
  RepoAgentConfigScanResult,
  ScannedAgentConfigEntry
} from '../services/repo-agent-config-scanner';
import type { AgentConfigGrant } from '../state/agent-config-grants';

export const AGENT_CONFIG_APPROVE_ONCE_LABEL = 'Approve This Run';
export const AGENT_CONFIG_PERSIST_LABEL = 'Acknowledge for This Workspace';

export type AgentConfigAckDecisionChoice = 'this-run' | 'persist' | 'denied';

const SHORT_DIGEST_LEN = 12;

function shortDigest(digest: string): string {
  return digest.slice(0, SHORT_DIGEST_LEN);
}

function describeUnreadableReason(reason: AgentConfigUnreadableReason): string {
  switch (reason) {
    case 'symlink':
      return 'symlink refused (not followed)';
    case 'not-a-regular-file':
      return 'not a regular file';
    case 'size-limit-exceeded':
      return 'exceeds 256 KiB scan limit';
    case 'escapes-root':
      return 'path outside workspace root';
    case 'timeout':
      return 'scan timed out';
    case 'io-failed':
      return 'could not be read';
  }
}

function formatEntryLine(entry: ScannedAgentConfigEntry): string {
  if (entry.status === 'unreadable') {
    return `- ${entry.name} [UNREADABLE: ${describeUnreadableReason(entry.unreadableReason)}]`;
  }
  const parts: string[] = [
    `${entry.size} B`,
    `sha256:${shortDigest(entry.digest)}`
  ];
  if (entry.hookEvents && entry.hookEvents.length > 0) {
    parts.push(`hooks: ${entry.hookEvents.join(', ')}`);
  }
  if (entry.settingKeys && entry.settingKeys.length > 0) {
    parts.push(`keys: ${entry.settingKeys.join(', ')}`);
  }
  if (entry.metadataMalformed) {
    parts.push('invalid JSON (hook metadata unreadable)');
  }
  return `- ${entry.name} (${parts.join(' · ')})`;
}

/**
 * Describe what changed between the previously acknowledged configuration and
 * the current scan using file names and short digests only — never values.
 */
function buildChangeLines(
  scan: RepoAgentConfigScanResult,
  previousGrant: AgentConfigGrant
): readonly string[] {
  const prevByName = new Map(previousGrant.files.map((f) => [f.name, f]));
  const currByName = new Map(scan.entries.map((e) => [e.name, e]));
  const lines: string[] = [];

  for (const entry of scan.entries) {
    const prior = prevByName.get(entry.name);
    if (prior === undefined) {
      lines.push(
        entry.status === 'present'
          ? `  + added: ${entry.name} (sha256:${shortDigest(entry.digest)})`
          : `  + added: ${entry.name} [UNREADABLE: ${describeUnreadableReason(entry.unreadableReason)}]`
      );
    } else if (entry.status === 'unreadable') {
      lines.push(
        `  ~ changed: ${entry.name} (was sha256:${shortDigest(prior.digest)} → UNREADABLE: ${describeUnreadableReason(entry.unreadableReason)})`
      );
    } else if (entry.digest !== prior.digest) {
      lines.push(
        `  ~ modified: ${entry.name} (sha256:${shortDigest(prior.digest)} → sha256:${shortDigest(entry.digest)})`
      );
    }
  }

  if (!scan.scanError) {
    for (const prior of previousGrant.files) {
      if (!currByName.has(prior.name)) {
        lines.push(`  - removed: ${prior.name} (was sha256:${shortDigest(prior.digest)})`);
      }
    }
  }

  return lines;
}

export function buildAgentConfigAckPrompt(
  scan: RepoAgentConfigScanResult,
  previousGrant?: AgentConfigGrant | null
): { readonly message: string; readonly detail: string; readonly actions: readonly string[] } {
  const count = scan.entries.length;
  const noun = count === 1 ? 'file' : 'files';
  const hasChange = previousGrant !== undefined && previousGrant !== null;
  const message = scan.scanError
    ? `Schegent could not finish scanning repository agent configuration for uncontained '${scan.backend}'.`
    : hasChange
      ? `Repository agent configuration changed for uncontained '${scan.backend}' (${count} ${noun}).`
      : `This repository defines agent configuration for uncontained '${scan.backend}' (${count} ${noun}).`;

  const lines: string[] = [];
  if (count > 0) {
    lines.push('Discovered repository configuration (metadata only — values are never shown):');
    for (const entry of scan.entries) {
      lines.push(formatEntryLine(entry));
    }
  }
  if (scan.scanError) {
    const reason = scan.scanErrorReason === 'timeout' ? 'scan exceeded time budget' : 'scan failed';
    lines.push(`Scan warning: ${reason}; configuration is treated as unreadable.`);
  }

  if (hasChange) {
    const changes = buildChangeLines(scan, previousGrant);
    if (changes.length > 0) {
      lines.push('');
      lines.push('Changes since last acknowledgement:');
      lines.push(...changes);
    }
  }

  lines.push('');
  lines.push(
    `Because '${scan.backend}' runs without an OS-enforced sandbox, it may execute hooks or follow instructions from this repository.`
  );
  if (scan.persistable) {
    lines.push(
      `"${AGENT_CONFIG_PERSIST_LABEL}" remembers these exact digests for this workspace only. Any change asks again.`
    );
  } else {
    lines.push(
      'One or more entries could not be read safely, so this decision applies to this run only and cannot be remembered.'
    );
  }

  const actions = scan.persistable
    ? [AGENT_CONFIG_APPROVE_ONCE_LABEL, AGENT_CONFIG_PERSIST_LABEL]
    : [AGENT_CONFIG_APPROVE_ONCE_LABEL];

  return {
    message,
    detail: lines.join('\n'),
    actions
  };
}

export function createAgentConfigAckRequester(deps: {
  readonly confirm: ModalChoice;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}): (
  scan: RepoAgentConfigScanResult,
  previousGrant?: AgentConfigGrant | null
) => Promise<AgentConfigAckDecisionChoice> {
  return async (
    scan: RepoAgentConfigScanResult,
    previousGrant?: AgentConfigGrant | null
  ): Promise<AgentConfigAckDecisionChoice> => {
    const prompt = buildAgentConfigAckPrompt(scan, previousGrant);

    let choice: string | undefined;
    try {
      choice = await deps.confirm(prompt.message, prompt.detail, prompt.actions);
    } catch (error) {
      deps.logger.warn(
        `agent-config.ack unavailable backend=${scan.backend} count=${scan.entries.length} ` +
          `reason=${errorMessage(error)}`
      );
      return 'denied';
    }

    const decision: AgentConfigAckDecisionChoice =
      scan.persistable && choice === AGENT_CONFIG_PERSIST_LABEL
        ? 'persist'
        : choice === AGENT_CONFIG_APPROVE_ONCE_LABEL
          ? 'this-run'
          : 'denied';

    deps.logger.info(
      `agent-config.ack ${decision === 'denied' ? 'denied' : 'granted'} ` +
        `scope=${decision} backend=${scan.backend} count=${scan.entries.length}`
    );
    return decision;
  };
}
