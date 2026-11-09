/**
 * FR-R6-F06 (T041, T047, FR-012) — execution outcomes: the attempt outcome and the root outcome.
 *
 * Attempt rows are written by ingestion (one per attempt, under exactly one root); the query
 * counts attempts and distinct roots from them. This module records what happened to an
 * attempt. A changed outcome is one `outcome` revision; recording the outcome an attempt
 * already has writes nothing and answers the latest revision, so a redelivered terminal event
 * is idempotent.
 *
 * The outcome is a current value, not an as-of value: a revision-pinned read filters by the
 * outcome the attempt has now (recorded in the feature review).
 *
 * A root counts once. Each terminal transition of a root appends a row with the next
 * `transition_seq` under its own `outcome` revision; the latest row is the current outcome and
 * the earlier rows are its history. A transition equal to any recorded one (same outcome, same
 * terminal time) is a redelivery: it answers that row and leaves the current outcome alone, so a
 * late copy of an earlier transition cannot reopen history. A root id the legacy epoch
 * imported is refused `legacy-epoch-overlap`, so no run is counted in both epochs.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  ATTEMPT_OUTCOMES,
  ROOT_OUTCOMES,
  type AccountingResult,
  type AttemptOutcome,
  type RootOutcome
} from '../../contracts/usage-accounting/accounting-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { inImmediateTransaction } from './accounting-transaction';
import { isUtcInstant } from './observation-normalizer';
import { appendRevision, latestRevision } from './projection';

export interface AttemptOutcomeRequest {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
}

export interface AttemptOutcomeResult {
  readonly revision: number;
}

export interface RootOutcomeRequest {
  readonly rootId: string;
  readonly outcome: RootOutcome;
  readonly terminalUtc: string;
}

export interface RootOutcomeResult {
  readonly transitionSeq: number;
  readonly revision: number;
}

const ATTEMPT_ID_MAX_CHARS = 128;
const ROOT_ID_MAX_CHARS = 128;
const REQUEST_KEYS: ReadonlySet<string> = new Set(['attemptId', 'outcome']);
const ROOT_REQUEST_KEYS: ReadonlySet<string> = new Set(['rootId', 'outcome', 'terminalUtc']);

function refuseField(field: string): AccountingResult<never> {
  return { ok: false, refusal: { code: 'invalid-observation', detail: field } };
}

function validateRequest(input: unknown): AccountingResult<AttemptOutcomeRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuseField('request');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !REQUEST_KEYS.has(key))) return refuseField('request');
  const { attemptId, outcome } = raw;
  if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > ATTEMPT_ID_MAX_CHARS) {
    return refuseField('attemptId');
  }
  if (typeof outcome !== 'string' || !(ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) {
    return refuseField('outcome');
  }
  return { ok: true, value: { attemptId, outcome: outcome as AttemptOutcome } };
}

/** Records an attempt's outcome. Validates `input`; an unseen attempt is `unknown-attempt`. */
export function recordAttemptOutcome(
  conn: NodeSqliteConnection,
  input: unknown,
  nowUtc: string
): AccountingResult<AttemptOutcomeResult> {
  const validated = validateRequest(input);
  if (!validated.ok) return validated;
  const { attemptId, outcome } = validated.value;
  return inImmediateTransaction(conn, (): AccountingResult<AttemptOutcomeResult> => {
    const current = conn.scalar('SELECT outcome FROM accounting_attempts WHERE attempt_id = ?', attemptId);
    if (current === undefined) return { ok: false, refusal: { code: 'unknown-attempt' } };
    if (current === outcome) return { ok: true, value: { revision: latestRevision(conn) } };
    conn.run('UPDATE accounting_attempts SET outcome = ? WHERE attempt_id = ?', outcome, attemptId);
    // Cutoff 0 keeps the previous cutoff: an outcome projects no observation, so it must not
    // claim one whose intent is still pending.
    return { ok: true, value: { revision: appendRevision(conn, 'outcome', nowUtc, 0) } };
  });
}

function validateRootRequest(input: unknown): AccountingResult<RootOutcomeRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuseField('request');
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== ROOT_REQUEST_KEYS.size || keys.some((key) => !ROOT_REQUEST_KEYS.has(key))) return refuseField('request');
  const { rootId, outcome, terminalUtc } = raw;
  if (typeof rootId !== 'string' || rootId.length === 0 || rootId.length > ROOT_ID_MAX_CHARS) return refuseField('rootId');
  if (typeof outcome !== 'string' || !(ROOT_OUTCOMES as readonly string[]).includes(outcome)) return refuseField('outcome');
  if (!isUtcInstant(terminalUtc)) return refuseField('terminalUtc');
  return { ok: true, value: { rootId, outcome: outcome as RootOutcome, terminalUtc } };
}

interface RecordedTransition {
  readonly transition_seq: number | bigint;
  readonly revision: number | bigint;
}

/** Appends a root's terminal transition. Validates `input`; see the module comment. */
export function recordRootOutcome(
  conn: NodeSqliteConnection,
  input: unknown,
  nowUtc: string
): AccountingResult<RootOutcomeResult> {
  const validated = validateRootRequest(input);
  if (!validated.ok) return validated;
  const { rootId, outcome, terminalUtc } = validated.value;
  return inImmediateTransaction(conn, (): AccountingResult<RootOutcomeResult> => {
    if (conn.scalar('SELECT 1 FROM accounting_legacy_runs WHERE run_id = ?', rootId) !== undefined) {
      return { ok: false, refusal: { code: 'legacy-epoch-overlap' } };
    }
    const recorded = conn.get<RecordedTransition>(
      `SELECT transition_seq, revision FROM accounting_root_outcomes
        WHERE root_id = ? AND outcome = ? AND terminal_utc = ? ORDER BY transition_seq LIMIT 1`,
      rootId,
      outcome,
      terminalUtc
    );
    if (recorded !== undefined) {
      return { ok: true, value: { transitionSeq: Number(recorded.transition_seq), revision: Number(recorded.revision) } };
    }
    const latest = conn.get<RecordedTransition>(
      'SELECT transition_seq, revision FROM accounting_root_outcomes WHERE root_id = ? ORDER BY transition_seq DESC LIMIT 1',
      rootId
    );
    const transitionSeq = latest === undefined ? 1 : Number(latest.transition_seq) + 1;
    // Cutoff 0 keeps the previous cutoff, as for an attempt outcome.
    const revision = appendRevision(conn, 'outcome', nowUtc, 0);
    conn.run(
      'INSERT INTO accounting_root_outcomes (root_id, transition_seq, outcome, terminal_utc, revision) VALUES (?, ?, ?, ?, ?)',
      rootId,
      transitionSeq,
      outcome,
      terminalUtc,
      revision
    );
    return { ok: true, value: { transitionSeq, revision } };
  });
}
