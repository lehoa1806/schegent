/**
 * FR-R6-F08 (research R1) — DDL of SQLite migration 5, `005_f08_recovery_handoff`.
 *
 * Additive and forward-only: five `STRICT` tables, one index and two triggers; no table of
 * migrations 1 to 4 is altered. The v1 `recovery_manifests` and F15 `handoff*` tables stay as
 * they are: the first needs `runs` rows production does not write before F01-B, the second
 * models step-to-step transfer, not recovery.
 *
 * No table has a foreign key to `runs`; keys point only among these five tables. No column
 * holds content: only identities, enums, digests, counts and the bounded metadata manifest.
 *
 * The CHECK value lists are spelled out, not built from the contract constants: the
 * migration checksum covers this text, so it must never change once shipped.
 * `handoff-schema.test.ts` asserts the lists still equal the constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F08_HANDOFF_MIGRATION_VERSION = 5 as const;
export const F08_HANDOFF_MIGRATION_NAME = '005_f08_recovery_handoff' as const;

export const F08_HANDOFF_TABLE_NAMES = Object.freeze([
  'recovery_handoffs',
  'recovery_handoff_revisions',
  'recovery_handoff_references',
  'recovery_handoff_deliveries',
  'recovery_handoff_decisions'
] as const);

export const F08_HANDOFF_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS recovery_handoffs (
    handoff_id TEXT PRIMARY KEY CHECK (length(handoff_id) = 64),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
    root_execution_id TEXT NOT NULL CHECK (length(root_execution_id) BETWEEN 1 AND 128),
    invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 128),
    source_attempt_id TEXT NOT NULL CHECK (length(source_attempt_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'delivering', 'acknowledged', 'uncertain', 'consumed', 'superseded', 'unsupported')),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    closed_reason TEXT CHECK (closed_reason IN ('delivered', 'abandoned', 'superseded')),
    current_revision INTEGER CHECK (current_revision >= 1),
    pin_purpose TEXT CHECK (pin_purpose IN ('pending-handoff', 'uncertain-recovery', 'paused-recovery')),
    pin_purpose_target TEXT CHECK (pin_purpose_target IN ('pending-handoff', 'uncertain-recovery', 'paused-recovery')),
    legacy_provenance TEXT CHECK (length(CAST(legacy_provenance AS BLOB)) <= 2048),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (workspace_id, root_execution_id, invocation_id, source_attempt_id),
    CHECK ((closed_reason IS NOT NULL) = (state = 'consumed' OR state = 'superseded'))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recovery_handoff_revisions (
    handoff_id TEXT NOT NULL REFERENCES recovery_handoffs(handoff_id),
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'superseded')),
    cutoff_key TEXT NOT NULL CHECK (length(cutoff_key) = 64),
    execution_revision TEXT NOT NULL CHECK (length(execution_revision) BETWEEN 1 AND 128),
    usage_revision INTEGER NOT NULL CHECK (usage_revision >= 0),
    fact_cutoff_ms INTEGER NOT NULL CHECK (fact_cutoff_ms >= 0),
    manifest_version INTEGER NOT NULL CHECK (manifest_version >= 1),
    manifest_json TEXT NOT NULL CHECK (length(CAST(manifest_json AS BLOB)) <= 16384),
    manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
    certainty TEXT NOT NULL CHECK (certainty IN ('safe', 'uncertain', 'unknown')),
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unavailable')),
    issued_at_ms INTEGER,
    superseded_at_ms INTEGER,
    PRIMARY KEY (handoff_id, revision_no),
    UNIQUE (handoff_id, cutoff_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recovery_handoff_references (
    handoff_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL,
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 128),
    role TEXT NOT NULL CHECK (role IN ('validated', 'partial', 'evidence', 'checkpoint')),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    expected_digest TEXT CHECK (expected_digest IS NULL OR length(expected_digest) = 64),
    pin_state TEXT NOT NULL CHECK (pin_state IN ('pending', 'pinned', 'refused', 'released')),
    pin_refusal TEXT CHECK (pin_refusal IS NULL OR length(pin_refusal) BETWEEN 1 AND 64),
    last_resolution TEXT CHECK (last_resolution IN ('available', 'missing', 'expired', 'deleted', 'unreadable', 'changed', 'unsupported')),
    resolved_at_ms INTEGER,
    PRIMARY KEY (handoff_id, revision_no, artifact_id, role),
    UNIQUE (handoff_id, revision_no, artifact_id),
    FOREIGN KEY (handoff_id, revision_no) REFERENCES recovery_handoff_revisions(handoff_id, revision_no)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recovery_handoff_deliveries (
    intent_id TEXT PRIMARY KEY CHECK (length(intent_id) = 64),
    handoff_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL,
    target_attempt_id TEXT NOT NULL CHECK (length(target_attempt_id) BETWEEN 1 AND 128),
    envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64),
    transport TEXT NOT NULL CHECK (transport IN ('acp', 'direct')),
    backend_id TEXT NOT NULL CHECK (length(backend_id) BETWEEN 1 AND 128),
    profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
    profile_version TEXT NOT NULL CHECK (length(profile_version) BETWEEN 1 AND 128),
    owner_digest TEXT NOT NULL CHECK (length(owner_digest) = 64),
    session_plan TEXT NOT NULL CHECK (session_plan IN ('load-session', 'fresh-session')),
    session_reason TEXT CHECK (session_reason IN ('owner-mismatch', 'profile-changed', 'backend-changed', 'capability-absent', 'capability-unknown', 'legacy-session', 'uncertain-prior', 'no-prior-session', 'capabilities-changed')),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 128),
    connection_id TEXT CHECK (connection_id IS NULL OR length(connection_id) BETWEEN 1 AND 128),
    prompt_id TEXT CHECK (prompt_id IS NULL OR length(prompt_id) BETWEEN 1 AND 128),
    capabilities_digest TEXT NOT NULL CHECK (length(capabilities_digest) = 64),
    access_plan_digest TEXT NOT NULL CHECK (length(access_plan_digest) = 64),
    outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'acknowledged', 'uncertain', 'refused')),
    outcome_reason TEXT CHECK (outcome_reason IN ('not-sent', 'restart-before-ack', 'connection-lost')),
    decision_id TEXT CHECK (decision_id IS NULL OR length(decision_id) = 64),
    recorded_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER,
    UNIQUE (handoff_id, target_attempt_id),
    FOREIGN KEY (handoff_id, revision_no) REFERENCES recovery_handoff_revisions(handoff_id, revision_no),
    CHECK ((session_id IS NOT NULL) = (session_plan = 'load-session')),
    CHECK ((session_reason IS NOT NULL) = (session_plan = 'fresh-session'))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recovery_handoff_decisions (
    decision_id TEXT PRIMARY KEY CHECK (length(decision_id) = 64),
    handoff_id TEXT NOT NULL REFERENCES recovery_handoffs(handoff_id),
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    decision TEXT NOT NULL CHECK (decision IN ('continue-new-attempt', 'abandon')),
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'refused-stale', 'refused-closed')),
    consumed_by_intent_id TEXT CHECK (consumed_by_intent_id IS NULL OR length(consumed_by_intent_id) = 64),
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS recovery_handoff_deliveries_by_outcome
    ON recovery_handoff_deliveries (handoff_id, outcome)`,
  `CREATE TRIGGER IF NOT EXISTS recovery_handoff_revisions_immutable
    BEFORE UPDATE ON recovery_handoff_revisions
    WHEN OLD.status <> 'draft' AND (
      NEW.handoff_id IS NOT OLD.handoff_id OR NEW.revision_no IS NOT OLD.revision_no
      OR NEW.cutoff_key IS NOT OLD.cutoff_key OR NEW.execution_revision IS NOT OLD.execution_revision
      OR NEW.usage_revision IS NOT OLD.usage_revision OR NEW.fact_cutoff_ms IS NOT OLD.fact_cutoff_ms
      OR NEW.manifest_version IS NOT OLD.manifest_version OR NEW.manifest_json IS NOT OLD.manifest_json
      OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.certainty IS NOT OLD.certainty
      OR NEW.coverage IS NOT OLD.coverage OR NEW.issued_at_ms IS NOT OLD.issued_at_ms
      OR (OLD.status = 'superseded' AND (NEW.status IS NOT 'superseded' OR NEW.superseded_at_ms IS NOT OLD.superseded_at_ms))
      OR (OLD.status = 'issued' AND NEW.status = 'draft')
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery handoff revision is immutable once issued');
    END`,
  `CREATE TRIGGER IF NOT EXISTS recovery_handoff_revisions_keep_issued
    BEFORE DELETE ON recovery_handoff_revisions
    WHEN OLD.status <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'recovery handoff revision is immutable once issued');
    END`
]);
