// Feature 103 (FR-013, FR-014) — whether a run was started on its own or as a
// member of a Workflow.
//
// A second question about the same run, and deliberately a second field.
// `CatalogVersionRef` already answers "which published definition and version
// did this run's body come from?", and for a Workflow member the answer to that
// is a *Pipeline*: a connected run freezes each member Pipeline at start and each
// member executes that Pipeline's snapshot. So `catalogVersion.kind` is never
// `'workflow'` on a recorded run, and reading it as the run's kind would report
// every Workflow member as a standalone Pipeline run. FR-014 requires both
// answers on the same row because neither can be derived from the other.
//
// Deliberately not in the contracts barrel, for the reason `catalog-version.ts`
// gives: the barrel is almost entirely `export *`, which
// `tests/lint/contracts-module-reachability.test.ts` excludes from its corpus
// precisely so a barrel entry cannot stand in for a real consumer. Import this
// by path.

/**
 * How a run was started.
 *
 * **Stamped once at completion, never derived at read time** (FR-013). The
 * obvious alternative — look the run up in `ConnectedWorkflowRun` when the row
 * is rendered — fails on a record the operator may delete: a row that says
 * "part of Workflow X" today would say "started on its own" tomorrow, and the
 * history record is supposed to be the thing that does not change.
 *
 * **Absence means not recorded.** Entries written before this field existed have
 * no origin, and no reader may fill one in. Absent is a third state the surface
 * states plainly (FR-012); it is not a synonym for `'standalone'`.
 */
export type RunOriginRef =
  | {
      /** The run was started on its own, from the Runs launch surface. */
      readonly kind: 'standalone';
    }
  | {
      /** The run executed as one member of a connected Workflow run. */
      readonly kind: 'workflow-member';
      /**
       * The Workflow definition id that connected this run.
       *
       * An id, not a display name (FR-021 resolves names at read time and falls
       * back to the id). Never `''` — a present-but-blank identity is neither
       * "recorded" nor "absent", and no producer may write one.
       */
      readonly workflowId: string;
    };

/**
 * Whether a value read back from durable state is an origin.
 *
 * Reject, never repair, for the reason `isCatalogVersionRef` gives — with one
 * extra edge that matters more here. A `{kind:'workflow-member'}` with no id is
 * tempting to default to `'standalone'`, and that default would state on a row
 * that a Workflow member ran alone. Dropping it lands on "not recorded", which
 * is the only true thing left to say about it.
 */
export function isRunOriginRef(value: unknown): value is RunOriginRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === 'standalone') return true;
  return (
    ref.kind === 'workflow-member'
    && typeof ref.workflowId === 'string'
    && ref.workflowId.length > 0
  );
}
