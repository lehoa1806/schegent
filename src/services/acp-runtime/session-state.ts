/**
 * FR-R6-F13 (FR-012, FR-015, FR-016, research R5) — the sessions of one connection, their turns
 * and the attribution of every observation.
 *
 * - Turn ids are `turn-<generation>-<n>`, with `n` counted per connection from 1, so a turn id
 *   never repeats inside a generation and never collides across generations.
 * - While `session/load` is outstanding an observation is `history`: no attempt, no binding,
 *   turn `history-<generation>`.
 * - During a prompt it is `live` and carries that prompt's attempt, turn and binding.
 * - Otherwise it is `live` with no attempt and no binding, turn `idle-<generation>`.
 *
 * Zero `vscode` imports.
 */
import type { AcpObservationOrigin, AcpTimer } from '../../contracts/acp-runtime';
import type { AcpAttemptBinding } from '../usage-accounting/acp-usage-mapping';

export interface TurnState {
  readonly turnId: string;
  readonly requestId: number;
  readonly attemptId: string;
  readonly binding: AcpAttemptBinding;
  cancelling: boolean;
  cancelTimer: AcpTimer | null;
}

interface SessionState {
  loading: boolean;
  turn: TurnState | null;
}

export interface Attribution {
  readonly origin: AcpObservationOrigin;
  readonly turnId: string;
  readonly attemptId: string | null;
  readonly binding: AcpAttemptBinding | null;
}

export class SessionTable {
  private readonly sessions = new Map<string, SessionState>();
  private turnCounter = 0;

  constructor(
    private readonly profileId: string,
    private readonly generation: number
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  add(sessionId: string, loading: boolean): void {
    this.sessions.set(sessionId, { loading, turn: null });
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  endLoad(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.loading = false;
  }

  isLoading(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loading === true;
  }

  turnOf(sessionId: string): TurnState | null {
    return this.sessions.get(sessionId)?.turn ?? null;
  }

  /** Opens a turn for one written prompt; the caller has checked the session is idle. */
  beginTurn(sessionId: string, requestId: number, attemptId: string, rootId: string): TurnState {
    this.turnCounter += 1;
    const turnId = `turn-${this.generation}-${this.turnCounter}`;
    const binding: AcpAttemptBinding = {
      profileId: this.profileId,
      acpSessionId: sessionId,
      connectionGeneration: this.generation,
      turnId,
      rootId,
      attemptId
    };
    const turn: TurnState = { turnId, requestId, attemptId, binding, cancelling: false, cancelTimer: null };
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.turn = turn;
    return turn;
  }

  endTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.turn === null) return;
    session.turn.cancelTimer?.cancel();
    session.turn = null;
  }

  /** Every open turn, for teardown. */
  openTurns(): TurnState[] {
    const turns: TurnState[] = [];
    for (const session of this.sessions.values()) {
      if (session.turn !== null) turns.push(session.turn);
    }
    return turns;
  }

  /** Research R5: the origin and attribution of an observation for one known session. */
  attributionFor(sessionId: string): Attribution {
    const session = this.sessions.get(sessionId);
    if (session?.loading === true) {
      return { origin: 'history', turnId: `history-${this.generation}`, attemptId: null, binding: null };
    }
    const turn = session?.turn ?? null;
    if (turn !== null) return { origin: 'live', turnId: turn.turnId, attemptId: turn.attemptId, binding: turn.binding };
    return { origin: 'live', turnId: `idle-${this.generation}`, attemptId: null, binding: null };
  }
}
