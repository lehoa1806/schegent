/**
 * FR-R6-F09 (FR-017, F09-AC-08) — ACP callback authority boundary, SQLite provenance receipts,
 * and post-cancellation surviving-helper group verification.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { qualifyBackend } from '../../../src/services/containment-qualification/qualify';
import {
  AcpAuthorityGate,
  verifyAcpTransportTeardown
} from '../../../src/services/containment-qualification/acp-authority-gate';
import { spawnStdioTransport } from '../../../src/services/acp-runtime/stdio-transport';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

describe('FR-R6-F09 T017 — ACP authority gate and containment channel (F09-AC-08)', () => {
  it('qualifies ACP channels explicitly and marks unqualified-acp false even on observed tuples', () => {
    const base = {
      kind: 'codex' as const,
      executable: 'resolved' as const,
      versionMinor: '0.163',
      os: 'darwin',
      arch: 'arm64',
      environmentPolicyDigest: 'a'.repeat(64)
    };

    const bridged = qualifyBackend({ ...base, acp: 'bridge-stdio-v1' });
    expect(bridged.key.acp).toBe('bridge-stdio-v1');
    expect(bridged.qualified).toBe(true);

    const unqualifiedAcp = qualifyBackend({ ...base, acp: 'unqualified-acp' });
    expect(unqualifiedAcp.key.acp).toBe('unqualified-acp');
    expect(unqualifiedAcp.qualified).toBe(false);
  });

  it('enforces session binding, primacy changes, protected DB/credential targets, F15 inputs, and duplicate effect refusal', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, status, revision,
          created_at_ms, updated_at_ms
        ) VALUES ('run-1', 'ws-1', 'wf-1', 'running', 1, 1000, 1000)`
      );
      conn.run(
        `INSERT INTO steps (
          step_id, run_id, step_index, phase_id, status, revision, updated_at_ms
        ) VALUES ('step-1', 'run-1', 0, 'implement', 'running', 1, 1000)`
      );
      conn.run(
        `INSERT INTO attempts (
          attempt_id, run_id, step_id, attempt_number, status, started_at_ms
        ) VALUES ('att-1', 'run-1', 'step-1', 1, 'running', 1000)`
      );

      let trusted = true;
      let holdsPrimacy = true;
      let ownershipGen = 7;
      let cancelling = false;

      const laneRoot = path.join(os.tmpdir(), 'schegent-f09-lane-1');
      const primaryRoot = path.join(os.tmpdir(), 'schegent-f09-primary');
      const dbFile = path.join(primaryRoot, '.schegent', 'state.sqlite3');
      const upstreamArtifact = path.join(primaryRoot, '.schegent', 'artifacts', 'spec-accepted.md');

      const gate = new AcpAuthorityGate(
        {
          isWorkspaceTrusted: () => trusted,
          holdsPrimacy: () => holdsPrimacy,
          currentOwnershipGeneration: () => ownershipGen,
          isTurnCancelling: () => cancelling,
          nowMs: () => 1_700_000_005_000
        },
        conn
      );

      gate.registerScope({
        attemptId: 'att-1',
        acpSessionId: 'sess-valid',
        connectionGeneration: 3,
        ownershipGeneration: 7,
        executionRoot: laneRoot,
        primaryWorkspaceRoot: primaryRoot,
        protectedDatabasePaths: [dbFile],
        authorizedUpstreamInputPaths: [upstreamArtifact]
      });

      // 1. Forged / unknown session refuses
      const forged = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-forged',
        connectionGeneration: 3,
        mutating: false,
        targetPath: path.join(laneRoot, 'src/index.ts')
      });
      expect(forged.allowed).toBe(false);
      expect(forged.reason).toBe('session-attempt-mismatch');

      // 2. Stale connection generation refuses
      const staleGen = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-valid',
        connectionGeneration: 2,
        mutating: false,
        targetPath: path.join(laneRoot, 'src/index.ts')
      });
      expect(staleGen.allowed).toBe(false);
      expect(staleGen.reason).toBe('stale-connection-generation');

      // 3. SQLite database / WAL / credential access refuses
      for (const forbiddenTarget of [
        dbFile,
        `${dbFile}-wal`,
        path.join(laneRoot, '.env.production'),
        path.join(laneRoot, '.schegent', 'audit.ndjson'),
        path.join(primaryRoot, 'outside.txt')
      ]) {
        const res = gate.authorize({
          requestKind: 'filesystem',
          acpSessionId: 'sess-valid',
          connectionGeneration: 3,
          mutating: false,
          targetPath: forbiddenTarget
        });
        expect(res.allowed, forbiddenTarget).toBe(false);
      }

      // 4. Explicit F15 upstream input reference is allowed for read ONLY, refused for write
      const upstreamRead = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-valid',
        connectionGeneration: 3,
        mutating: false,
        targetPath: upstreamArtifact
      });
      expect(upstreamRead.allowed).toBe(true);

      const upstreamWrite = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-valid',
        connectionGeneration: 3,
        mutating: true,
        targetPath: upstreamArtifact
      });
      expect(upstreamWrite.allowed).toBe(false);

      // 5. Effectful request inside executionRoot succeeds once, duplicate replay refuses
      const firstWrite = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-valid',
        connectionGeneration: 3,
        effectRequestKey: 'req-42',
        mutating: true,
        targetPath: path.join(laneRoot, 'src/feature.ts')
      });
      expect(firstWrite.allowed).toBe(true);

      const duplicateWrite = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-valid',
        connectionGeneration: 3,
        effectRequestKey: 'req-42',
        mutating: true,
        targetPath: path.join(laneRoot, 'src/feature.ts')
      });
      expect(duplicateWrite.allowed).toBe(false);
      expect(duplicateWrite.reason).toBe('duplicate-effect-request');

      // 6. Primacy generation change during approval refuses permission callback
      const policy = gate.createPermissionPolicy(3);
      expect(
        policy({
          sessionId: 'sess-valid',
          attemptId: 'att-1',
          toolCallId: 'tc-1',
          toolTitle: 'Write src/a.ts with SECRET_TOKEN=sk-fake',
          options: [
            { optionId: 'opt-allow', kind: 'allow_once' },
            { optionId: 'opt-reject', kind: 'reject_once' }
          ]
        })
      ).toEqual({ optionId: 'opt-allow' });

      ownershipGen = 8;
      expect(
        policy({
          sessionId: 'sess-valid',
          attemptId: 'att-1',
          toolCallId: 'tc-2',
          toolTitle: 'Write src/b.ts',
          options: [
            { optionId: 'opt-allow', kind: 'allow_once' },
            { optionId: 'opt-reject', kind: 'reject_once' }
          ]
        })
      ).toBe('undecided');

      // 7. Verify SQLite provenance rows exist for att-1 and carry ZERO raw paths or secret text
      const rows = conn.all<Record<string, unknown>>(
        `SELECT * FROM acp_authorization_receipts WHERE attempt_id = 'att-1'`
      );
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('sk-fake');
      expect(serialized).not.toContain(laneRoot);
      expect(serialized).not.toContain('.env.production');

      // Ensure cancelling & untrusted states also refuse cleanly
      ownershipGen = 7;
      trusted = false;
      expect(
        gate.authorize({
          requestKind: 'terminal',
          acpSessionId: 'sess-valid',
          connectionGeneration: 3,
          mutating: true
        }).reason
      ).toBe('workspace-untrusted');

      trusted = true;
      cancelling = true;
      expect(
        gate.authorize({
          requestKind: 'terminal',
          acpSessionId: 'sess-valid',
          connectionGeneration: 3,
          mutating: true
        }).decision
      ).toBe('cancelled');
    } finally {
      conn.close();
    }
  });

  it('verifies OS process-group exit on ACP transport teardown and detects surviving helpers', async () => {
    const cleanTransport = spawnStdioTransport({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume();'],
      cwd: os.tmpdir(),
      env: {}
    });
    const verification = await verifyAcpTransportTeardown(cleanTransport, 'darwin');
    expect(verification.outcome).toBe('group-exit-confirmed');

    // Synthetic transport stub simulating a surviving group member after protocol cancel/close
    const survivingStub = {
      pid: 99999,
      write: () => undefined,
      onStdout: () => undefined,
      onStderr: () => undefined,
      onClose: () => undefined,
      close: async () => undefined,
      isProcessTreeGone: () => false
    };
    const survivingResult = await verifyAcpTransportTeardown(survivingStub, 'darwin');
    expect(survivingResult).toEqual({
      outcome: 'residual',
      residuals: ['group-survived']
    });
  });
});
