// Feature 014 T023 — `CMD_SAVE_WAKEUP_SETTINGS` host save-handler.
//
// Implements the 8-step deterministic save protocol from
// specs/014-wake-up/contracts/wakeup-settings-ipc.md §Host-side save
// protocol. Returns the `{ok: true} | {ok: false, reason}` shape the
// message-router converts into the webview ACK.
//
// Rollback rule (FR-017): if the daemon driver fails AND the prior
// registration state was `registered === true`, the persisted settings
// are reverted to the pre-Save snapshot so the UI never "succeeds"
// while OS state diverges from config. If the prior state was
// unregistered, no rollback is needed — the config update reflects the
// operator intent and the next Save can re-attempt the install.
//
// Audit emission (FR-006 / FR-007 / FR-008 / FR-017): one event per
// successful Save (`wakeup-daemon-{installed,updated,uninstalled}`) or
// failed install (`wakeup-daemon-install-failed`). Payloads are
// sanitized by the existing `appendAudit` pipeline (CLAUDE.md hard
// rule: single sanitization point).

import type { DaemonManager, DaemonState } from './daemon-manager';
import { detectPlatform, type WakeUpPlatform } from './platform-detect';
import {
  SettingsValidationError,
  coerceWakeUpModel,
  readSettings,
  writeSettings,
  type WakeUpConfig,
  type WakeUpRejectReason,
  type WakeUpSettings
} from './settings';

/** Closed reject-reason vocabulary from contracts/wakeup-settings-ipc.md. */
export type SaveWakeUpRejectReason =
  | WakeUpRejectReason
  | 'unknown-key'
  | `daemon-install-failed:${string}`;

export interface SaveWakeUpPayload {
  readonly enabled: boolean;
  readonly schedulerType: 'chronological' | 'periodic';
  readonly chronologicalTime: string;
  readonly periodicInterval: string;
  // Feature 031 — operator's selected model identifier. Optional on
  // wire (the 014 baseline did not require it); when absent, the
  // handler persists the `'runner-default'` sentinel.
  readonly model?: string;
  // Any additional keys are rejected with `unknown-key` by `validateEnvelope`.
  readonly [extra: string]: unknown;
}

export type SaveWakeUpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SaveWakeUpRejectReason };

/**
 * Minimal slice of `AuditLogWriter.append` so the handler can be
 * unit-tested without instantiating the writer. Mirrors the production
 * call site exactly: synthetic `runId`, `phase: 'wakeup'`, `iteration: 0`.
 */
export interface AuditAppender {
  append(entry: {
    runId: string;
    phase: string;
    iteration: number;
    eventType: string;
    payload: Record<string, unknown>;
    outcome: 'success' | 'failure' | 'info';
  }): Promise<unknown>;
}

export interface SaveWakeUpHandlerDeps {
  readonly readConfig: () => WakeUpConfig;
  readonly daemonManager: DaemonManager;
  readonly workspaceRoots: () => readonly string[];
  readonly sourceRunnerPath: string;
  readonly homeDir: string;
  readonly audit: AuditAppender;
  /** Override for tests; defaults to `detectPlatform()`. */
  readonly platform?: () => WakeUpPlatform;
  /** Sanitizer for daemon-install error suffixes (denylist absolute paths). */
  readonly sanitize: (message: string) => string;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'schedulerType',
  'chronologicalTime',
  'periodicInterval',
  // Feature 031 — operator-selected Claude model id (or sentinel).
  'model'
]);

const SYNTHETIC_RUN_ID = 'wakeup-system';
const SYNTHETIC_PHASE = 'wakeup';

export function createSaveWakeUpSettingsHandler(deps: SaveWakeUpHandlerDeps) {
  return async (payload: SaveWakeUpPayload): Promise<SaveWakeUpResult> => {
    // 1. Pre-validate envelope (no extra keys, required keys present).
    const envelope = validateEnvelope(payload);
    if (!envelope.ok) return { ok: false, reason: envelope.reason };

    // Feature 031 — accept the new `model` key in the payload. When the
    // wire payload supplies an explicit string, pass it through to
    // `validateSettings` verbatim so a non-member id is rejected with
    // `'invalid-model'`. Absent / null / non-string values collapse to
    // the `'runner-default'` sentinel via `coerceWakeUpModel`.
    const proposedModel =
      typeof payload.model === 'string'
        ? (payload.model as WakeUpSettings['model'])
        : coerceWakeUpModel(payload.model);
    const proposed: WakeUpSettings = {
      enabled: payload.enabled,
      schedulerType: payload.schedulerType,
      chronologicalTime: payload.chronologicalTime,
      periodicInterval: payload.periodicInterval,
      model: proposedModel
    };

    const config = deps.readConfig();
    const platform = deps.platform ? deps.platform() : detectPlatform();

    // 2. Snapshot prior state for rollback (read BEFORE writing).
    const priorSettings = readSettings(config);
    let priorRegistration: DaemonState;
    try {
      priorRegistration = await deps.daemonManager.inspect();
    } catch {
      // `inspect()` failing is non-fatal for the save flow — treat as
      // "unknown prior state, assume not installed" so we never roll
      // back into a worse state than we found.
      priorRegistration = { registered: false, schedule: null };
    }

    // 3. Write settings transactionally. Validates first; on validation
    //    error the WakeUpRejectReason becomes the response reason
    //    (`invalid-*`, `periodic-interval-below-minimum`, etc).
    try {
      await writeSettings(config, proposed);
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        return { ok: false, reason: err.reason };
      }
      // Defensive: writeSettings should always wrap as SettingsValidationError,
      // but if a future change leaks a raw error, treat it as config-write.
      return { ok: false, reason: 'config-write-failed' };
    }

    // 4. Drive the daemon. Snapshot the workspace roots once so the
    //    audit event we emit below reports the SAME count that the
    //    runner-bundle just wrote to <homeDir>/workspace-roots.json
    //    (FR-024 — the runner reads that mirror at fire time).
    const rootsSnapshot = deps.workspaceRoots();
    const driveResult = await driveDaemon(deps, proposed, rootsSnapshot);
    if (!driveResult.ok) {
      // 5. Rollback rule: only roll back if the prior state was installed.
      //    A failed install when nothing was registered before leaves the
      //    config updated (operator intent preserved) — the next Save can
      //    re-attempt without losing typed values.
      if (priorRegistration.registered) {
        try {
          await writeSettings(config, priorSettings);
        } catch {
          /* swallow — best-effort rollback; the install-failed reason
             still carries the operator-meaningful suffix */
        }
      }

      // 6. Audit: install-failure event with sanitized reason.
      const sanitizedReason = deps.sanitize(driveResult.message);
      await emitAudit(deps.audit, 'wakeup-daemon-install-failed', 'failure', {
        platform,
        identifier: identifierFor(platform),
        reason: sanitizedReason
      });

      const suffix: `daemon-install-failed:${string}` = `daemon-install-failed:${sanitizedReason}`;
      return { ok: false, reason: suffix };
    }

    // 7. Audit: emit success event keyed on the transition.
    const event = classifyTransition(priorRegistration, proposed);
    await emitAudit(deps.audit, event, 'success', auditPayload(platform, proposed));

    // 8. Audit: when the runner bundle was rewritten (enabled=true), log
    //    the size of the workspace-roots mirror so operators can trace
    //    when the runner's defense set changes. PAYLOAD CARRIES THE
    //    COUNT ONLY — never the paths (FR-024 / T041, mirrors the
    //    redaction policy on workspace paths in the audit pipeline).
    if (proposed.enabled) {
      await emitAudit(deps.audit, 'wakeup-workspace-roots-updated', 'info', {
        platform,
        count: rootsSnapshot.length
      });
    }

    return { ok: true };
  };
}

interface DriveResult {
  readonly ok: boolean;
  readonly message: string;
}

async function driveDaemon(
  deps: SaveWakeUpHandlerDeps,
  proposed: WakeUpSettings,
  workspaceRoots: readonly string[]
): Promise<DriveResult> {
  try {
    if (proposed.enabled) {
      await deps.daemonManager.apply({
        settings: proposed,
        workspaceRoots,
        sourceRunnerPath: deps.sourceRunnerPath,
        homeDir: deps.homeDir
      });
    } else {
      await deps.daemonManager.uninstall();
    }
    return { ok: true, message: '' };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown';
    return { ok: false, message };
  }
}

function classifyTransition(
  prior: DaemonState,
  proposed: WakeUpSettings
): 'wakeup-daemon-installed' | 'wakeup-daemon-updated' | 'wakeup-daemon-uninstalled' {
  if (!proposed.enabled) return 'wakeup-daemon-uninstalled';
  if (prior.registered) return 'wakeup-daemon-updated';
  return 'wakeup-daemon-installed';
}

function auditPayload(platform: WakeUpPlatform, settings: WakeUpSettings): Record<string, unknown> {
  return {
    platform,
    identifier: identifierFor(platform),
    schedulerType: settings.schedulerType,
    scheduleExpression:
      settings.schedulerType === 'chronological'
        ? settings.chronologicalTime
        : settings.periodicInterval
  };
}

function identifierFor(platform: WakeUpPlatform): string {
  switch (platform) {
    case 'darwin':
      return 'com.schegent.wakeup';
    case 'win32':
      return 'Schegent\\WakeUp';
    case 'linux-systemd':
      return 'schegent-wakeup.timer';
    case 'linux-cron':
      return '# schegent-wakeup';
  }
}

async function emitAudit(
  audit: AuditAppender,
  eventType: string,
  outcome: 'success' | 'failure' | 'info',
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await audit.append({
      runId: SYNTHETIC_RUN_ID,
      phase: SYNTHETIC_PHASE,
      iteration: 0,
      eventType,
      payload,
      outcome
    });
  } catch {
    /* audit is best-effort; never fails the save */
  }
}

function validateEnvelope(
  payload: SaveWakeUpPayload
): { ok: true } | { ok: false; reason: SaveWakeUpRejectReason } {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'unknown-key' };
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: 'unknown-key' };
    }
  }
  // Required-key presence — missing keys fall through to the typed
  // validators in `writeSettings`, which produce a more specific
  // RejectReason (e.g. `invalid-scheduler-type` for missing/invalid).
  return { ok: true };
}
