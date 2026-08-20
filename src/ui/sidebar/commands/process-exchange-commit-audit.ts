// Feature 085 T067 (FR-059, FR-060, FR-061) — what a confirmed package import
// records about itself. Feature 100 (T513b): the two save commands it was shared
// by are gone, and the callers are now `catalog-lifecycle-commit.ts` (the package
// publish arm) and `cmd-save-models.ts`.
//
// Feature 084 audited a document refusal and a capability denial and deliberately
// audited neither a plan nor a write: one Phase either landed or it did not, and
// the catalog itself was the record. A package writes two catalogs that can
// succeed independently (FR-042a), so the catalog stops being that record — a
// workspace holding two Phases and no Pipeline is indistinguishable from one
// where the operator imported the Phases alone. These records are the difference.
//
// They reuse 084's envelope rather than adding a second one (research R10): the
// same six fields, one new `operation` literal, one new event type. The envelope
// is what FR-060 rests on — it has no field an instruction, a port label, a file
// name, or a workspace root could ride out in, and that stays true here.
//
// Scoped to the package import on purpose. A handler that audited every write
// would turn the exchange log into a second copy of the catalog's history, and
// 084's single-Phase `import` still records nothing at commit: one write cannot
// be partial, so the catalog still describes it.
//
// Feature 100 (T513b) kept that scoping through the lifecycle rewrite, and it is
// what decided the package publish arm's audit shape: a `definition-published`
// per definition alongside this record would be exactly the second copy the
// paragraph above rules out. The per-definition lifecycle events fire on the five
// per-definition operations only. The `import-package` mutation intent itself no
// longer travels on the three definition layers — a layer is identified by its
// `kind` — and this record's scope is now "the publish came from an import",
// which is the property it always meant.
//
// A capability denial is NOT one of these. It keeps `trust.capability-denied` —
// a different decision, taken at a different time, about a different thing
// (084's rule, unchanged).

import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import { RESOURCE_ID_MAX_LEN } from '../../../contracts/sidebar-ipc/process-yaml';
import type { ProcessYamlResourceKind } from '../../../services/process-yaml/types';
import type { HandlerContext } from './handler-contract';

/** Matches the row cap every other bounded list in these two handlers uses. */
const RESOURCE_IDS_MAX = 20;

/**
 * The one catalog write an `import-package` mutation is about. Built by the
 * handler, which is the only thing that knows how to read its own mutation kind.
 *
 * Feature 099 (FR-041) — `scope` is gone with the layer tier it named: there is
 * one catalog per kind, so the `resourceKind` already says where the write went.
 */
export interface ImportCommitTarget {
  readonly resourceKind: ProcessYamlResourceKind;
  /**
   * The ids the mutation declared. Still the webview's word for what the
   * document held at the earliest gates — the catalog has not validated them
   * yet — so they are bounded and sanitized on the way into the log.
   */
  readonly resourceIds: readonly string[];
}

function payloadFor(
  target: ImportCommitTarget,
  outcome: string,
  counts: Readonly<Record<string, number>>,
  sanitize: (value: string) => string
): ProcessExchangePayload {
  return {
    operation: 'import-commit',
    resourceKind: target.resourceKind,
    // Bounded at the catalog's own id length for this kind (FR-037), never at a
    // second limit declared here. `logger.sanitize` stays the single redaction
    // source — `SECRET_PATTERNS` is not forked (standing hard rule).
    resourceIds: target.resourceIds
      .slice(0, RESOURCE_IDS_MAX)
      .map((id) => sanitize(id).slice(0, RESOURCE_ID_MAX_LEN[target.resourceKind])),
    outcomes: [outcome],
    counts
  };
}

async function append(
  ctx: HandlerContext,
  eventType: 'process-exchange-import-committed' | 'process-exchange-import-refused',
  payload: ProcessExchangePayload,
  outcome: 'info' | 'failure'
): Promise<void> {
  if (!ctx.deps.audit) return;
  try {
    await ctx.deps.audit.append({
      runId: 'process-exchange:import-commit',
      phase: 'process-exchange',
      iteration: 0,
      eventType,
      payload: { ...payload },
      outcome,
      correlationId: ctx.correlationId
    });
  } catch (err) {
    // A record that could not be written must not turn a completed write into a
    // failure, nor a refusal into something worse than a refusal.
    ctx.deps.logger.warn(
      `sidebar router: process-yaml import commit audit append failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

/**
 * One kind of a package landed. `counts.imported` is the untruncated number of
 * declared ids even when `resourceIds` is capped, so the cap is visible rather
 * than silent (FR-049).
 *
 * A `null` target is every mutation that is not a package import, and is the
 * whole gate: callers pass it unconditionally and this returns.
 */
export async function auditImportCommitted(
  ctx: HandlerContext,
  target: ImportCommitTarget | null
): Promise<void> {
  if (target === null) return;
  await append(
    ctx,
    'process-exchange-import-committed',
    payloadFor(
      target,
      'imported',
      { imported: target.resourceIds.length },
      ctx.deps.logger.sanitize
    ),
    'info'
  );
}

/**
 * One kind of a package did not land, and `reason` is the save gate's own
 * rejection literal — never document-derived text (FR-060).
 *
 * Recorded for every gate an `import-package` write can be refused by, because
 * an unaudited refusal is indistinguishable from an operator who closed the
 * dialog, which is exactly what FR-061 forbids. The entry outcome is `failure`
 * for all of them: unlike a preflight refusal, which is an informational fact
 * about a document nobody asked to write yet, a commit refusal means a write the
 * operator confirmed did not happen.
 */
export async function auditImportRefused(
  ctx: HandlerContext,
  target: ImportCommitTarget | null,
  reason: string
): Promise<void> {
  if (target === null) return;
  await append(
    ctx,
    'process-exchange-import-refused',
    payloadFor(target, reason, { refused: 1 }, ctx.deps.logger.sanitize),
    'failure'
  );
}
