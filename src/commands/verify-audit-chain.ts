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
//
// FR-R4-F03 (FR-009, FR-016; contract O1) — ONE RESULT, BUILT IN ORDER. The chain verdict first (how it
// began, what retention removed, each diagnosed damage, or the first break), then exactly one of seven loss
// states read against the head checkpoint kept outside the workspace. The two loss states (`shorter`,
// `missing`) take the broken-link path: a warning and the audit sink failing with its own code. Every other
// state is told and changes no health. The command writes NO file in any window, and a "not performed" never
// says the history is complete. Operator text names basenames, counts and digest prefixes, never a path or
// row content.
import * as path from 'path';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { describeFailure } from '../lib/errors';
import { verifyAuditChainAt, type ChainVerdict } from '../audit/audit-chain';
import { classifyLoss, type CheckpointRead, type LossState } from '../audit/audit-checkpoint';

/** The command a loss finding sends the operator to. */
const RESET_COMMAND_TITLE = 'Schegent: Reset Audit History Checkpoint';
const MOVE_HISTORY_OUT = 'move the audit history out of .schegent/ first (the reset never deletes or moves evidence)';

/**
 * FR-R4-F05 (FR-014; contract O, O1) — the warning for a log the verifier could not read. Fixed
 * text: a read fault's message names the file's path, and the operator text names "basenames,
 * counts and digest prefixes, never a path". What was thrown goes to the log, through
 * `describeFailure`.
 */
export const CHAIN_UNREADABLE_TOAST =
  'Schegent could not verify the audit chain: the log could not be read. See the Schegent log for details.';

/** How the chain began, when a transition occurred (contract O1). */
export const TRANSITION_TEXT = {
  genesis: 'The chain began at genesis.',
  legacyTail: 'The chain began by linking to the last legacy row.'
} as const;

/** Said beside every diagnosed damage: a newline or a damage row is a record, not a repair (FR-009). */
export const DAMAGE_RECORDED_NOT_REPAIRED = 'this damage is recorded, not repaired';

const NOT_PERFORMED_REASON = {
  'checkpoint-unreadable': 'the checkpoint is unreadable',
  'checkpoint-version-unknown': 'the checkpoint was written by a newer release',
  'checkpoint-unreachable': 'the checkpoint could not be reached',
  'chain-not-intact': 'the chain is not intact'
} as const;

/**
 * What one loss state says to the operator, and at what level. Exported so tests pin the module's own
 * wording instead of a copy of it (contract O1). `warn` is reserved for the two states that fail audit
 * health.
 */
export function renderLossCheck(state: LossState): { readonly level: 'info' | 'warn'; readonly text: string } {
  switch (state.state) {
    case 'new-workspace':
      return {
        level: 'info',
        text: 'No audit history and no checkpoint: this workspace has no recorded history yet.'
      };
    case 'consistent':
      return {
        level: 'info',
        text:
          `History reaches the checkpointed entry ${state.position}; only entries after it could be ` +
          'missing undetected.'
      };
    case 'adopted':
      return {
        level: 'info',
        text:
          `History reaches the checkpointed entry ${state.position}. Loss detection began on ` +
          `${new Date(state.adoptedAtMs).toISOString().slice(0, 10)}; history before that was not checked ` +
          'for loss.'
      };
    case 'shorter':
      return {
        level: 'warn',
        text:
          (state.detail === 'tail-removed'
            ? `History is shorter than the checkpoint: expected at least ${state.expected} chained entries, ` +
              `found ${state.found}.`
            : `History no longer contains the checkpointed entry ${state.expected}, although ${state.found} ` +
              'entries are present.') +
          ` If this was deliberate, ${MOVE_HISTORY_OUT}, then run "${RESET_COMMAND_TITLE}".`
      };
    case 'missing':
      return {
        level: 'warn',
        text:
          `Established history is missing: the checkpoint expects ${state.expected} chained entries and no ` +
          `audit file is present. If this was deliberate, run "${RESET_COMMAND_TITLE}".`
      };
    case 'no-checkpoint-for-location':
      return {
        level: 'info',
        text:
          "History is present but no checkpoint exists for this folder's location: it predates loss " +
          'detection, or the folder was moved. The next recorded event in the owner window starts one.'
      };
    case 'not-performed':
      return {
        level: 'info',
        text: `The loss check was not performed: ${NOT_PERFORMED_REASON[state.reason]}.`
      };
  }
}

/** The chain's own facts, in the order an operator reads them (contract O1, step 1). */
function describeVerifiedChain(verdict: Extract<ChainVerdict, { ok: true }>): string {
  const parts: string[] = [];
  if (verdict.transition !== null) {
    parts.push(verdict.transition === 'genesis' ? TRANSITION_TEXT.genesis : TRANSITION_TEXT.legacyTail);
  }
  if (verdict.unchainedPrefix > 0) {
    parts.push(`${verdict.unchainedPrefix} leading entries predate the chain and are not covered by it.`);
  }
  if (verdict.prunedLegacy > 0) {
    parts.push(`${verdict.prunedLegacy} legacy entries were removed by recorded prunes.`);
  }
  for (const damage of verdict.damages) {
    parts.push(
      `Diagnosed damage: ${damage.file} line ${damage.line}, ${damage.byteLength} bytes, sha256 ` +
        `${damage.digestPrefix}; ${DAMAGE_RECORDED_NOT_REPAIRED}.`
    );
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

export interface VerifyAuditChainCtx {
  readonly workspaceRoot: string;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  /** Called only on a break, so a passing walk cannot clear an append failure. Writes no file. */
  readonly onBreak: (detail: string) => void;
  /** Called only for the two loss states, with a count-only detail. Writes no file. */
  readonly onLoss: (code: 'history-shorter' | 'history-missing', detail: string) => void;
  /** The stored head checkpoint, read-only and never throwing (`AuditLogWriter.readCheckpoint`). */
  readonly readCheckpoint: () => Promise<CheckpointRead>;
}

export async function runVerifyAuditChain(ctx: VerifyAuditChainCtx): Promise<void> {
  const auditDir = path.join(ctx.workspaceRoot, '.schegent');
  const stored = await ctx.readCheckpoint();
  let checked: ReturnType<typeof verifyAuditChainAt>;
  try {
    checked = verifyAuditChainAt(
      auditDir,
      stored.status === 'active' ? { probeDigest: stored.checkpoint.headDigest } : {}
    );
  } catch (err) {
    // An unanswerable check is a refusal, never a pass. The operator is told the chain could
    // not be read, which is a different and more urgent fact than "the chain is broken".
    ctx.logger.warn('audit chain verification could not read the log', {
      reasonCode: 'chain-unreadable',
      error: describeFailure(err, (value) => ctx.logger.sanitize(value))
    });
    ctx.notifier.warn(CHAIN_UNREADABLE_TOAST);
    return;
  }

  const loss = classifyLoss(stored, checked);
  const lossText = renderLossCheck(loss);
  if (loss.state === 'shorter') {
    ctx.onLoss('history-shorter', `the history has ${loss.found} chained entries and the checkpoint expects ${loss.expected}`);
  } else if (loss.state === 'missing') {
    ctx.onLoss('history-missing', `the checkpoint expects ${loss.expected} chained entries and no audit file is present`);
  }
  const lossLine = ` Loss check: ${lossText.text}`;

  if (checked === null) {
    // No audit file at all: a new workspace, or missing history, which the loss state tells apart.
    send(ctx.notifier, lossText.level, `Schegent: ${lossText.text}`);
    return;
  }

  const { files, verdict } = checked;
  const scanned = `${files.ordered.length} file(s)`;
  if (!verdict.ok) {
    const detail = `${verdict.reason} at entry ${verdict.atEntry}: ${verdict.detail}`;
    ctx.onBreak(detail);
    send(
      ctx.notifier,
      'warn',
      `Schegent: the audit chain is broken — ${detail} This names the FIRST break only; ` +
        `every later link is unverifiable until it is explained.${lossLine}`
    );
    return;
  }

  const unread =
    files.unrecognized.length > 0
      ? ` Not read (unrecognized name): ${files.unrecognized.join(', ')}.`
      : '';
  send(
    ctx.notifier,
    lossText.level,
    `Schegent: audit chain verified across ${scanned} — ${verdict.entries} chained ` +
      `entries, ${verdict.cuts} recorded prune(s).${describeVerifiedChain(verdict)}${unread}${lossLine}`
  );
}

function send(notifier: Notifier, level: 'info' | 'warn', message: string): void {
  if (level === 'warn') void notifier.warn(message);
  else notifier.info(message);
}
