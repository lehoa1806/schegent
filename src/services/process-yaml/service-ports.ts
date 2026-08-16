// Feature 089 T001/T003 — the narrow dependency ports the exchange services take
// instead of the editor host API (`data-model.md` §2).
//
// Declared once, in the service layer that needs them, because the preflight and
// export services need the *same* two ports: both read the stored catalog layers,
// both sanitize author-supplied strings, and both append to the audit log. Two
// identical copies would be a duplicated dependency vocabulary of exactly the kind
// FR-005 forbids for results — it drifts on the first edit that touches one file.
//
// This is deliberately NOT a dependency-injection container and NOT a headless
// module's idea of what a service should need. It is structural: the router's
// existing `RouterDeps` bag satisfies both interfaces as-is, so the host wires
// nothing new, and a test or an automation client supplies a smaller object.

import type { AuditEventType } from '../../contracts/audit-events';

/** One catalog layer's stored rows, whatever their status. */
interface StoredLayers {
  readonly user: readonly unknown[];
  readonly workspace: readonly unknown[];
}

/**
 * The stored rows of each catalog layer, exactly as the router already reads
 * them. Every reader is optional for the reason it is on `RouterDeps`: a unit
 * test that supplies none gets empty layers rather than a crash, and "no user
 * layer" is a legitimate state rather than a missing dependency.
 */
export interface ProcessCatalogPort {
  readonly readPhaseConfig?: () => StoredLayers;
  readonly readPipelineConfig?: () => StoredLayers;
  readonly readWorkflowConfig?: () => StoredLayers;
  /**
   * Feature 096 — Model Catalog has one writable layer, not `{user,
   * workspace}`, so its reader returns the current merged config directly
   * rather than a `StoredLayers` pair.
   */
  readonly readModelsConfig?: () => Record<string, readonly string[]>;
}

/**
 * The two things every exchange operation needs regardless of kind: a sanitizer
 * for author-supplied strings, and somewhere to record what happened.
 *
 * `logger.sanitize` is a member rather than an import, because `SECRET_PATTERNS`
 * stays the single redaction source and these services must use the host's
 * configured sanitizer rather than a second one of their own.
 *
 * `audit` is optional on the same terms it is on `RouterDeps`, and every caller
 * treats an absent writer as "nothing to record" rather than as a failure — a log
 * that cannot be written must not turn a clean outcome into one the operator has
 * to interpret.
 */
export interface DocumentAuditPort {
  readonly logger: {
    readonly sanitize: (value: string) => string;
    warn(message: string): void;
  };
  readonly audit?: {
    append(entry: {
      runId: string;
      phase: string;
      iteration: number;
      eventType: AuditEventType;
      payload: Record<string, unknown>;
      outcome: 'info' | 'success' | 'failure';
      correlationId?: string;
    }): Promise<unknown>;
  };
}

/** What both exchange services take. */
export type ExchangeDeps = ProcessCatalogPort & DocumentAuditPort;
