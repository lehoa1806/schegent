/**
 * FR-R6-F14 — the telemetry export surface: evaluate the profiles to one destination, the
 * exporter that maps, batches and delivers accounting metadata to it, the OTLP/HTTP transport,
 * and the in-memory ledger. Types are in `src/contracts/telemetry-export.ts`.
 *
 * Nothing in production constructs an exporter: the settings surface, the secret-store adapter
 * and the activation wiring belong to F14-B. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export { evaluateProfiles } from './destination-policy';
export { createInMemoryLedger } from './in-memory-ledger';
export { MAPPING_REVISION_1 } from './mapping-revision';
export { createOtlpHttpTransport, type NameLookup, type OtlpHttpTransportOptions } from './otlp-http-transport';
export { classifyDelivery, nextRetry } from './retry-policy';
export { createTelemetryExporter } from './telemetry-exporter';
