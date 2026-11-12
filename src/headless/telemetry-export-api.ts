/**
 * FR-R6-F14 (F14-FR-14, F14-AC-07) — editor-independent headless entry point for optional
 * OpenTelemetry export. Shares the exact normalization, destination policy, privacy allowlist,
 * durable SQLite ledger, and governed spool implementation as the VS Code extension host.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  buildProfileObjectFromUserSettings,
  buildTelemetryExportPreview,
  createTelemetryHostService,
  normalizeAcceptedObservationFromSqlite,
  type TelemetryExportPreview,
  type TelemetryHostService,
  type TelemetryHostServiceDeps,
  type TelemetryHostStatus,
  type TelemetryUserSettingsInput
} from '../services/telemetry-host/telemetry-host-service';

export {
  buildProfileObjectFromUserSettings,
  buildTelemetryExportPreview,
  createTelemetryHostService,
  normalizeAcceptedObservationFromSqlite,
  type TelemetryExportPreview,
  type TelemetryHostService,
  type TelemetryHostServiceDeps,
  type TelemetryHostStatus,
  type TelemetryUserSettingsInput
};
