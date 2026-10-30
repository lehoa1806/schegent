// FR-R4-F04 (FR-020, contract E1; data-model §6) — the closed outcome of one export, and the one audit
// payload it becomes.
//
// An export is an operator act that moves evidence out of the workspace, and until this feature it left no
// trace: not that it happened, not what it carried, not that it was refused. Each export command (the Run
// evidence export, the audit-metadata export and the diagnostics bundle) now ends in exactly one of three
// things: no row (the operator dismissed a dialog before anything was decided), one `refused` row (a
// refusal after the request was made), or one `exported` row (the write completed).
//
// The shape is deliberately small and closed. It carries WHAT was exported (a kind), HOW it ended, two
// counts, and a refusal CODE. It cannot carry a destination, a file name, an actor or content: there is no
// field for any of them, and `projectEvidenceExported` (`src/audit/evidence-lifecycle-payload.ts`) rejects
// a payload with a key this type does not have. That is what makes "an export row names no path" a
// property of the type, and not of every caller's care.
//
// Lives in `contracts/` because the writers of the three commands, the audit projector and the tests all
// read it, and a contract may not depend on any of them.

/** What was exported. */
export const EXPORT_KINDS = ['run-evidence', 'audit-metadata', 'diagnostics-bundle'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Why an export was refused. A code, never a message: the operator's text lives with the command. */
export const EXPORT_REFUSALS = [
  'destination-in-evidence-store',
  'destination-not-local-file',
  'destination-unresolvable',
  'no-evidence',
  'invalid-run-id',
  'write-failed'
] as const;
export type ExportRefusal = (typeof EXPORT_REFUSALS)[number];

export const EXPORT_OUTCOMES = ['exported', 'refused'] as const;

/**
 * One export's end. `included` and `omitted` are counts: manifest entries and deliberate omissions for a
 * Run export, rows written and rows skipped for the audit export, items written and items left out for the
 * bundle. A refusal writes nothing, so its `included` is `0`.
 */
export type ExportOutcome =
  | {
      readonly kind: ExportKind;
      readonly outcome: 'exported';
      readonly included: number;
      readonly omitted: number;
    }
  | {
      readonly kind: ExportKind;
      readonly outcome: 'refused';
      readonly included: 0;
      readonly omitted: number;
      readonly refusal: ExportRefusal;
    };

/** The audit payload: exactly the keys of the outcome, `refusal` only on a refusal. */
export function exportOutcomePayload(outcome: ExportOutcome): Readonly<Record<string, string | number>> {
  const base = {
    kind: outcome.kind,
    outcome: outcome.outcome,
    included: outcome.included,
    omitted: outcome.omitted
  };
  return Object.freeze(outcome.outcome === 'refused' ? { ...base, refusal: outcome.refusal } : base);
}
