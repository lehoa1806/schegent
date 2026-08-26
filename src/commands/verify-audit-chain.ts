// FR-R3-112 (FR-125) — the chain verification, reachable from the product and not only from
// a terminal.
//
// WHY A COMMAND AS WELL AS `npm run audit:verify`. An operator inspecting evidence is in the
// editor, not in a shell at the repository root, and the script's path assumptions are the
// repository's. More to the point: a verifier only an engineer can run is a control the
// product does not have. The item's own wording is "reachable both as a command and from the
// evidence-health surface", and these are the same reachability from two entry points.
//
// WHAT A BREAK DOES TO THE SURFACE. It reports the audit sink as failing, through the same
// `EvidenceHealthReporter` an unwritable log already reports through — so a broken chain
// reads as what it is: evidence you cannot rely on. It deliberately does NOT report success
// into that machinery: a verified chain says nothing about whether the last append landed, and
// clearing a real append failure because a hash walk passed would be a false all-clear.
import * as path from 'path';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { verifyAuditChainAt } from '../audit/audit-chain';

export interface VerifyAuditChainCtx {
  readonly workspaceRoot: string;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  /** Called only on a break, so a passing walk cannot clear an append failure. */
  readonly onBreak: (detail: string) => void;
}

export function runVerifyAuditChain(ctx: VerifyAuditChainCtx): void {
  const auditDir = path.join(ctx.workspaceRoot, '.schegent');
  let checked: ReturnType<typeof verifyAuditChainAt>;
  try {
    checked = verifyAuditChainAt(auditDir);
  } catch (err) {
    // An unanswerable check is a refusal, never a pass. The operator is told the chain could
    // not be read, which is a different and more urgent fact than "the chain is broken".
    const message = err instanceof Error ? err.message : 'unknown error';
    ctx.logger.warn('audit chain verification could not read the log', {
      reasonCode: 'chain-unreadable'
    });
    ctx.notifier.warn(
      `Schegent could not verify the audit chain: the log could not be read (${message}).`
    );
    return;
  }

  if (checked === null) {
    ctx.notifier.info('Schegent: no audit log yet, so there is no chain to verify.');
    return;
  }

  const { files, verdict } = checked;
  const scanned = `${files.ordered.length} file(s)`;
  if (!verdict.ok) {
    const detail = `${verdict.reason} at entry ${verdict.atEntry}: ${verdict.detail}`;
    ctx.onBreak(detail);
    ctx.notifier.warn(
      `Schegent: the audit chain is broken — ${detail} This names the FIRST break only; ` +
        'every later link is unverifiable until it is explained.'
    );
    return;
  }

  const unchained =
    verdict.unchainedPrefix > 0
      ? ` ${verdict.unchainedPrefix} leading entries predate the chain and are not covered by it.`
      : '';
  const unread =
    files.unrecognized.length > 0
      ? ` Not read (unrecognized name): ${files.unrecognized.join(', ')}.`
      : '';
  ctx.notifier.info(
    `Schegent: audit chain verified across ${scanned} — ${verdict.entries} chained ` +
      `entries, ${verdict.cuts} recorded prune(s).${unchained}${unread}`
  );
}
