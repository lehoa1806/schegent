// FR-R4-F04 (FR-020, contract E2) — the closed projection of an `evidence-exported` audit row.
//
// `projectCatalogLifecycle` is the template: the generic projector copies whatever keys a payload has and
// only rejects values that look like paths or secrets, so for an event that must NEVER carry a destination,
// a file name or an actor the closure has to be a mechanism and not a convention. This names exactly the
// five keys an `ExportOutcome` has, takes each from its enum or its integer range, and copies nothing
// else. Anything it does not recognise throws `AuditPayloadValidationError` with
// `malformed-evidence-exported`, so a caller's mistake is a visible missing row and never a written wrong
// one.

import {
  EXPORT_KINDS,
  EXPORT_OUTCOMES,
  EXPORT_REFUSALS,
  exportOutcomePayload,
  type ExportKind,
  type ExportOutcome,
  type ExportRefusal
} from '../contracts/evidence-export-outcome';
import { AuditPayloadValidationError } from './audit-payload-error';

const REASON = 'malformed-evidence-exported';
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'outcome', 'included', 'omitted', 'refusal']);

const reject = (): AuditPayloadValidationError => new AuditPayloadValidationError(REASON);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The closed projection of an `evidence-exported` payload; throws `AuditPayloadValidationError` for anything outside it. */
export function projectEvidenceExported(payload: Record<string, unknown>): Readonly<Record<string, string | number>> {
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) throw reject();
  const { kind, outcome, included, omitted, refusal } = payload;
  if (typeof kind !== 'string' || !(EXPORT_KINDS as readonly string[]).includes(kind)) throw reject();
  if (typeof outcome !== 'string' || !(EXPORT_OUTCOMES as readonly string[]).includes(outcome)) throw reject();
  if (!isCount(included) || !isCount(omitted)) throw reject();

  if (outcome === 'exported') {
    if (refusal !== undefined) throw reject();
    return exportOutcomePayload({ kind: kind as ExportKind, outcome: 'exported', included, omitted } satisfies ExportOutcome);
  }
  if (typeof refusal !== 'string' || !(EXPORT_REFUSALS as readonly string[]).includes(refusal)) throw reject();
  if (included !== 0) throw reject();
  return exportOutcomePayload({
    kind: kind as ExportKind,
    outcome: 'refused',
    included: 0,
    omitted,
    refusal: refusal as ExportRefusal
  });
}
