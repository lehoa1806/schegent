// FR-R6-F07 (FR-005) — the applied live-log cursor kept in webview state, so a
// recreated view resumes where the last one stopped.
//
// The record holds the selection the cursor belongs to, the cursor and the
// generation. Both are opaque host strings; no log content is kept. It is
// written beside the keys already in webview state, never over them, and a
// cursor is handed back only for the selection it was written for.

import type { PhaseLogSelection } from '../../../src/services/phase-log/types.js';
import { getWebviewState, setWebviewState } from './vscode-api';

const RESUME_KEY = 'liveLogResume';

export interface LiveLogResumeRecord {
  readonly selection: PhaseLogSelection;
  readonly cursor: string;
  readonly generation: string;
}

function isSelection(value: unknown): value is PhaseLogSelection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const iteration = candidate.iterationN;
  return (
    typeof candidate.queueId === 'string' &&
    typeof candidate.taskId === 'string' &&
    typeof candidate.pipelineId === 'string' &&
    typeof candidate.phaseId === 'string' &&
    (iteration === null || typeof iteration === 'number')
  );
}

function isResumeRecord(value: unknown): value is LiveLogResumeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isSelection(candidate.selection) &&
    typeof candidate.cursor === 'string' &&
    typeof candidate.generation === 'string'
  );
}

function sameSelection(a: PhaseLogSelection, b: PhaseLogSelection): boolean {
  return (
    a.queueId === b.queueId &&
    a.taskId === b.taskId &&
    a.pipelineId === b.pipelineId &&
    a.phaseId === b.phaseId &&
    a.iterationN === b.iterationN
  );
}

/** The persisted record, or null when there is none or it is not shaped as one. */
export function readLiveLogResume(): LiveLogResumeRecord | null {
  const state = getWebviewState<Record<string, unknown>>();
  const record = state?.[RESUME_KEY];
  return isResumeRecord(record) ? record : null;
}

/** The record's cursor when it was written for `selection`; otherwise null. */
export function resumeCursorFor(
  record: LiveLogResumeRecord | null,
  selection: PhaseLogSelection
): string | null {
  if (record === null) return null;
  return sameSelection(record.selection, selection) ? record.cursor : null;
}

/** Writes the record beside the keys already in webview state. */
export function writeLiveLogResume(record: LiveLogResumeRecord): void {
  const prior = getWebviewState<Record<string, unknown>>();
  setWebviewState({ ...(prior ?? {}), [RESUME_KEY]: record });
}
