// FR-R6-F11 — a shared run-store fixture for the reporting tests.
//
// Seeds `runs`, `steps` and `attempts` rows straight into a migrated in-memory store, so each
// test names only the fields it is about.

import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

export const FIXTURE_NOW = 1_800_000_000_000;
export const FIXTURE_WORKSPACE = 'ws-1';

export interface SeedRun {
  readonly runId: string;
  readonly createdAtMs: number;
  readonly workspaceId?: string;
  readonly workflowId?: string;
  readonly frozenClosureId?: string | null;
  readonly status?: string;
  readonly startedAtMs?: number | null;
  readonly completedAtMs?: number | null;
  readonly terminalReason?: string | null;
}

export interface SeedAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly attemptNumber: number;
  readonly startedAtMs: number;
  readonly phaseId?: string;
  readonly status?: string;
  readonly exitCode?: number | null;
  readonly completedAtMs?: number | null;
}

export function withStore(body: (conn: NodeSqliteConnection) => void): void {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => FIXTURE_NOW);
    body(conn);
  } finally {
    conn.close();
  }
}

/** `withStore` for an async body: the store closes once the body settles. */
export async function withStoreAsync(body: (conn: NodeSqliteConnection) => Promise<void>): Promise<void> {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => FIXTURE_NOW);
    await body(conn);
  } finally {
    conn.close();
  }
}

export function seedRun(conn: NodeSqliteConnection, run: SeedRun): void {
  conn.run(
    `INSERT INTO runs (run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
       current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
    run.runId,
    run.workspaceId ?? FIXTURE_WORKSPACE,
    run.workflowId ?? 'wf-a',
    run.frozenClosureId ?? null,
    run.status ?? 'succeeded',
    run.startedAtMs ?? null,
    run.completedAtMs ?? null,
    run.terminalReason ?? null,
    run.createdAtMs,
    run.createdAtMs
  );
}

/** Seeds an attempt, creating its step on first use. */
export function seedAttempt(conn: NodeSqliteConnection, attempt: SeedAttempt): void {
  const stepId = `${attempt.runId}-s${String(attempt.stepIndex)}`;
  conn.run(
    `INSERT OR IGNORE INTO steps (step_id, run_id, step_index, phase_id, status, revision,
       current_attempt_id, updated_at_ms)
     VALUES (?, ?, ?, ?, 'succeeded', 1, NULL, ?)`,
    stepId,
    attempt.runId,
    attempt.stepIndex,
    attempt.phaseId ?? `phase-${String(attempt.stepIndex)}`,
    attempt.startedAtMs
  );
  conn.run(
    `INSERT INTO attempts (attempt_id, run_id, step_id, attempt_number, status, exit_code,
       started_at_ms, completed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    attempt.attemptId,
    attempt.runId,
    stepId,
    attempt.attemptNumber,
    attempt.status ?? 'succeeded',
    attempt.exitCode ?? null,
    attempt.startedAtMs,
    attempt.completedAtMs ?? null
  );
}
