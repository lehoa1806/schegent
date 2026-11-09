/**
 * FR-R6-F04 (F04-B, FR-017) — `AgentRuntimeStoreAdapter` for `F13`:
 * Manages `agent_profiles`, `agent_profile_versions`, `agent_sessions`,
 * `provider_sessions`, `agent_session_provider_links`, `agent_connections`,
 * `agent_session_connections`, `agent_turns`, `protocol_receipts`,
 * `effect_intents`, `effect_observations`, and strictly non-authoritative
 * `projection_intents`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import type {
  AgentConnectionRow,
  AgentProfileRow,
  AgentProfileVersionRow,
  AgentSessionRow,
  AgentTurnRow,
  EffectIntentRow,
  EffectObservationRow,
  ProjectionIntentRow,
  ProtocolReceiptRow,
  ProviderSessionRow
} from '../../../contracts/sqlite-store/domain-adapter-types';
import type { NodeSqliteConnection } from '../sqlite-driver';

export class AgentRuntimeStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public upsertProfileAndVersion(params: {
    readonly profileId: string;
    readonly name: string;
    readonly provider: string;
    readonly adapterKind: AgentProfileRow['adapterKind'];
    readonly profileVersionId: string;
    readonly versionNumber: number;
    readonly configJson: string;
  }): { readonly profile: AgentProfileRow; readonly version: AgentProfileVersionRow } {
    const now = this.nowMs();
    const configSha256 = createHash('sha256').update(params.configJson).digest('hex');

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO agent_profiles (profile_id, name, provider, adapter_kind, active_version_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET active_version_id = excluded.active_version_id`,
        params.profileId,
        params.name,
        params.provider,
        params.adapterKind,
        params.profileVersionId,
        now
      );

      this.conn.run(
        `INSERT INTO agent_profile_versions (profile_version_id, profile_id, version_number, config_json, config_sha256, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        params.profileVersionId,
        params.profileId,
        params.versionNumber,
        params.configJson,
        configSha256,
        now
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }

    return {
      profile: {
        profileId: params.profileId,
        name: params.name,
        provider: params.provider,
        adapterKind: params.adapterKind,
        activeVersionId: params.profileVersionId,
        createdAtMs: now
      },
      version: {
        profileVersionId: params.profileVersionId,
        profileId: params.profileId,
        versionNumber: params.versionNumber,
        configJson: params.configJson,
        configSha256,
        createdAtMs: now
      }
    };
  }

  public createAgentSession(params: {
    readonly agentSessionId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly profileVersionId: string;
    readonly state?: AgentSessionRow['state'] | undefined;
  }): AgentSessionRow {
    const now = this.nowMs();
    const state = params.state ?? 'active';
    this.conn.run(
      `INSERT INTO agent_sessions (
        agent_session_id, run_id, step_id, attempt_id, profile_version_id, state, revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      params.agentSessionId,
      params.runId,
      params.stepId,
      params.attemptId,
      params.profileVersionId,
      state,
      now,
      now
    );
    return {
      agentSessionId: params.agentSessionId,
      runId: params.runId,
      stepId: params.stepId,
      attemptId: params.attemptId,
      profileVersionId: params.profileVersionId,
      state,
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now
    };
  }

  public linkProviderSession(params: {
    readonly linkId: string;
    readonly agentSessionId: string;
    readonly providerSessionId: string;
    readonly provider: string;
    readonly externalSessionRef: string;
    readonly capabilitiesJson: string;
  }): ProviderSessionRow {
    const now = this.nowMs();
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO provider_sessions (provider_session_id, provider, external_session_ref, capabilities_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_session_id) DO NOTHING`,
        params.providerSessionId,
        params.provider,
        params.externalSessionRef,
        params.capabilitiesJson,
        now
      );
      this.conn.run(
        `INSERT INTO agent_session_provider_links (link_id, agent_session_id, provider_session_id, linked_at_ms)
         VALUES (?, ?, ?, ?)`,
        params.linkId,
        params.agentSessionId,
        params.providerSessionId,
        now
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }

    return {
      providerSessionId: params.providerSessionId,
      provider: params.provider,
      externalSessionRef: params.externalSessionRef,
      capabilitiesJson: params.capabilitiesJson,
      createdAtMs: now
    };
  }

  public bindSessionConnection(params: {
    readonly bindingId: string;
    readonly agentSessionId: string;
    readonly connectionId: string;
    readonly transportKind: AgentConnectionRow['transportKind'];
    readonly pid: number | null;
    readonly boundEpoch: number;
  }): AgentConnectionRow {
    const now = this.nowMs();
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO agent_connections (connection_id, transport_kind, state, pid, connected_at_ms, disconnected_at_ms)
         VALUES (?, ?, 'connected', ?, ?, NULL)
         ON CONFLICT(connection_id) DO UPDATE SET state = 'connected', pid = excluded.pid`,
        params.connectionId,
        params.transportKind,
        params.pid,
        now
      );
      this.conn.run(
        `INSERT INTO agent_session_connections (binding_id, agent_session_id, connection_id, bound_epoch, bound_at_ms, unbound_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        params.bindingId,
        params.agentSessionId,
        params.connectionId,
        params.boundEpoch,
        now
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }

    return {
      connectionId: params.connectionId,
      transportKind: params.transportKind,
      state: 'connected',
      pid: params.pid,
      connectedAtMs: now,
      disconnectedAtMs: null
    };
  }

  public recordTurn(params: {
    readonly turnId: string;
    readonly agentSessionId: string;
    readonly turnIndex: number;
    readonly state: AgentTurnRow['state'];
    readonly promptArtifactId?: string | null | undefined;
    readonly responseArtifactId?: string | null | undefined;
  }): AgentTurnRow {
    const now = this.nowMs();
    const completedAtMs = params.state === 'completed' || params.state === 'failed' ? now : null;
    this.conn.run(
      `INSERT INTO agent_turns (
        turn_id, agent_session_id, turn_index, state, prompt_artifact_id, response_artifact_id, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params.turnId,
      params.agentSessionId,
      params.turnIndex,
      params.state,
      params.promptArtifactId ?? null,
      params.responseArtifactId ?? null,
      now,
      completedAtMs
    );
    return {
      turnId: params.turnId,
      agentSessionId: params.agentSessionId,
      turnIndex: params.turnIndex,
      state: params.state,
      promptArtifactId: params.promptArtifactId ?? null,
      responseArtifactId: params.responseArtifactId ?? null,
      startedAtMs: now,
      completedAtMs
    };
  }

  public recordProtocolReceipt(params: {
    readonly receiptId: string;
    readonly agentSessionId: string;
    readonly turnId?: string | null | undefined;
    readonly direction: ProtocolReceiptRow['direction'];
    readonly messageType: string;
    readonly sequenceNo: number;
    readonly payloadSha256: string;
  }): ProtocolReceiptRow {
    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO protocol_receipts (
        receipt_id, agent_session_id, turn_id, direction, message_type, sequence_no, payload_sha256, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params.receiptId,
      params.agentSessionId,
      params.turnId ?? null,
      params.direction,
      params.messageType,
      params.sequenceNo,
      params.payloadSha256,
      now
    );
    return {
      receiptId: params.receiptId,
      agentSessionId: params.agentSessionId,
      turnId: params.turnId ?? null,
      direction: params.direction,
      messageType: params.messageType,
      sequenceNo: params.sequenceNo,
      payloadSha256: params.payloadSha256,
      recordedAtMs: now
    };
  }

  public declareEffectIntent(params: {
    readonly effectIntentId: string;
    readonly agentSessionId: string;
    readonly turnId: string;
    readonly effectKind: EffectIntentRow['effectKind'];
    readonly idempotencyKey: string;
    readonly targetSummary: string;
    readonly status?: EffectIntentRow['status'] | undefined;
  }): EffectIntentRow {
    const now = this.nowMs();
    const status = params.status ?? 'declared';
    this.conn.run(
      `INSERT INTO effect_intents (
        effect_intent_id, agent_session_id, turn_id, effect_kind, idempotency_key, target_summary, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params.effectIntentId,
      params.agentSessionId,
      params.turnId,
      params.effectKind,
      params.idempotencyKey,
      params.targetSummary,
      status,
      now
    );
    return {
      effectIntentId: params.effectIntentId,
      agentSessionId: params.agentSessionId,
      turnId: params.turnId,
      effectKind: params.effectKind,
      idempotencyKey: params.idempotencyKey,
      targetSummary: params.targetSummary,
      status,
      createdAtMs: now
    };
  }

  public recordEffectObservation(params: {
    readonly observationId: string;
    readonly effectIntentId: string;
    readonly outcome: EffectObservationRow['outcome'];
    readonly exitCode?: number | null | undefined;
    readonly artifactId?: string | null | undefined;
  }): EffectObservationRow {
    const now = this.nowMs();
    const nextStatus = params.outcome === 'succeeded' ? 'executed' : 'failed';
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO effect_observations (observation_id, effect_intent_id, outcome, exit_code, artifact_id, observed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        params.observationId,
        params.effectIntentId,
        params.outcome,
        params.exitCode ?? null,
        params.artifactId ?? null,
        now
      );
      this.conn.run(
        `UPDATE effect_intents SET status = ? WHERE effect_intent_id = ?`,
        nextStatus,
        params.effectIntentId
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }

    return {
      observationId: params.observationId,
      effectIntentId: params.effectIntentId,
      outcome: params.outcome,
      exitCode: params.exitCode ?? null,
      artifactId: params.artifactId ?? null,
      observedAtMs: now
    };
  }

  /**
   * Records a strictly non-authoritative `projection_intents` row.
   * Requires that `sourceRevision <= agent_sessions.revision` so UI projections
   * never outrun committed authoritative session state (`FR-017`).
   */
  public enqueueProjectionIntent(params: {
    readonly projectionId: string;
    readonly agentSessionId: string;
    readonly sourceRevision: number;
    readonly targetSurface: ProjectionIntentRow['targetSurface'];
    readonly payloadJson: string;
  }): ProjectionIntentRow {
    const sessionRow = this.conn.get<{ revision: number }>(
      `SELECT revision FROM agent_sessions WHERE agent_session_id = ?`,
      params.agentSessionId
    );
    if (!sessionRow || params.sourceRevision > sessionRow.revision) {
      throw new Error(
        `UNCOMMITTED_PROJECTION_REVISION: sourceRevision=${params.sourceRevision} exceeds committed session revision=${sessionRow?.revision ?? 0}`
      );
    }

    const now = this.nowMs();
    this.conn.run(
      `INSERT INTO projection_intents (
        projection_id, agent_session_id, source_revision, target_surface, payload_json, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      params.projectionId,
      params.agentSessionId,
      params.sourceRevision,
      params.targetSurface,
      params.payloadJson,
      now
    );
    const initialIntentStatus: ProjectionIntentRow['status'] = 'pending';
    return {
      projectionId: params.projectionId,
      agentSessionId: params.agentSessionId,
      sourceRevision: params.sourceRevision,
      targetSurface: params.targetSurface,
      payloadJson: params.payloadJson,
      status: initialIntentStatus,
      createdAtMs: now
    };
  }
}
