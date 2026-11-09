// FR-R5-F36 (F36-T04, FR-008) — pure multi-task instruction splitter and batch status helpers.
//
// Splitting happens only on lines whose trimmed content equals `---schegent-task---`
// (case-sensitive). Inline occurrences of the delimiter token inside a line with other
// prose are kept intact so operators can mention the token in task instructions.

export const TASK_DELIMITER = '---schegent-task---';

export interface BatchSubmissionState {
  readonly inFlight: boolean;
  readonly halted: boolean;
  readonly accepted: number;
  readonly total: number;
}

/**
 * Split raw Instructions text on whole-line `---schegent-task---` delimiters.
 *
 * Each resulting block is trimmed and empty/whitespace-only blocks are dropped.
 * Zero or one returned segment means single-task mode; two or more means batch mode.
 */
export function splitTaskInstructions(text: string | undefined): readonly string[] {
  if (text === undefined || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === TASK_DELIMITER) {
      const candidate = currentLines.join('\n').trim();
      if (candidate.length > 0) {
        segments.push(candidate);
      }
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  const trailing = currentLines.join('\n').trim();
  if (trailing.length > 0) {
    segments.push(trailing);
  }

  return segments;
}

/**
 * Rejoin the unsubmitted remainder (starting at `acceptedCount`) with canonical
 * whole-line `---schegent-task---` delimiters so the operator can edit and resubmit
 * without re-adding the tasks already accepted by the host.
 */
export function remainingAfter(
  source: string | readonly string[],
  acceptedCount: number
): string {
  const segments = typeof source === 'string' ? splitTaskInstructions(source) : source;
  const startIndex = Math.max(0, acceptedCount);
  return segments.slice(startIndex).join(`\n\n${TASK_DELIMITER}\n\n`);
}

export function submitButtonLabel(options: {
  readonly pending: boolean;
  readonly queueId: string | undefined;
  readonly segmentCount: number;
}): string {
  const { pending, queueId, segmentCount } = options;
  if (segmentCount >= 2) {
    return pending ? `Adding ${segmentCount} tasks…` : `Add ${segmentCount} tasks`;
  }
  if (pending) return 'Submitting…';
  return queueId === undefined ? 'Run Workflow' : 'Add task';
}

export function formatBatchHaltStatus(
  accepted: number,
  total: number,
  detail: string
): string {
  return `Added ${accepted} of ${total} tasks. ${detail}`;
}

export function formatBatchTimeoutStatus(
  accepted: number,
  total: number,
  baseMessage: string
): string {
  return `Added ${accepted} of ${total} tasks; task ${accepted + 1} of ${total} is awaiting host acknowledgement. ${baseMessage}`;
}

