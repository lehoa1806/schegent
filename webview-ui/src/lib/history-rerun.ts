// Feature 103 (T065, T067, T068 — FR-034 to FR-037, FR-055, FR-059) — what a
// re-run would actually do, resolved before the form opens.
//
// Re-run is the one History action that starts work, and every claim it makes
// is about something the operator cannot see: which published version it will
// freeze, which queue it will land in, and whether it is repeating one Pipeline
// out of a Workflow rather than the Workflow. A history row answers none of
// those — it records what happened, and all three are questions about now.
//
// So the join lives here, as a pure function over the row and the two
// projections the surface already holds, and every arm is named. The rule the
// spec keeps returning to is that a substitution which is not stated is
// indistinguishable from a faithful repeat: silently using today's version when the
// operator asked for the run they are looking at, or quietly landing in the
// default queue because the original was deleted. Both are correct behaviour
// and both are wrong to do silently, which is why `supersededVersionId` and
// `queue.substituted` exist as fields rather than as rendered prose.
//
// Nothing here decides whether the composed run is valid. `validateRunRequest()`
// host-side owns every field rule for a launch, and re-run is a launch (FR-038);
// a second oracle in this file would disagree with the authoritative one the
// moment either moved.

// Extensioned specifiers, matching `history-rows.ts` — see its header. The
// default queue id is a value, so it is imported rather than mirrored: a second
// copy of `'default'` is a second thing to keep true.
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry.js';
import type { HistoryRow } from './history-rows.js';
import type { Launchable, LaunchProjection, LaunchSection, QueueRuntime } from './snapshot-types.js';

/**
 * Why re-run is not on offer.
 *
 * Six arms and not one, because each names a different next action: wait for
 * the catalog, accept that the row cannot say what it ran, import a process
 * document, publish something, publish *this* one, or use the launch surface.
 * Collapsing them into "unavailable" would satisfy FR-037's first sentence and
 * defeat its second.
 */
export type RerunUnavailableReason =
  /** The launch projection has not arrived. Absence is loading, not emptiness. */
  | 'catalog-loading'
  /** The row recorded no version, so which definition it ran is unrecoverable. */
  | 'definition-not-recorded'
  /** The row's frozen body was not a Pipeline, so this form cannot repeat it. */
  | 'not-a-pipeline-run'
  /** The catalog holds no Pipelines at all (098 FR-031's remedy: import one). */
  | 'catalog-empty'
  /** Pipelines exist, none published. */
  | 'none-published'
  /** Others are published; this definition is not. */
  | 'definition-not-published';

/** Which queue the re-run would land in, and whether that is the original. */
export interface RerunQueueTarget {
  readonly queueId: string;
  readonly name: string;
  /** FR-059 — true when the historical queue is gone and the default stands in. */
  readonly substituted: boolean;
}

export type RerunTarget =
  | { readonly state: 'unavailable'; readonly reason: RerunUnavailableReason }
  | {
      readonly state: 'ready';
      /** The Active version, which is the only thing the projection lists (FR-034). */
      readonly launchable: Launchable;
      /**
       * FR-035, FR-036 — the historical version id when it is no longer Active,
       * and `null` when it still is. Not the pair of ids: a form that renders
       * "v1 → v1" is announcing a difference that does not exist.
       */
      readonly supersededVersionId: string | null;
      /** FR-055 — the Workflow this run was a member of, if it was one. */
      readonly workflowMemberOf: string | null;
      readonly queue: RerunQueueTarget;
    };

/**
 * Find the Active definition, or say why there is none.
 *
 * Returns the reason as a bare string rather than throwing or returning `null`,
 * so the three ways a section can fail to yield an entry stay three answers all
 * the way out to the sentence the operator reads.
 */
function fromSection(section: LaunchSection, id: string): Launchable | RerunUnavailableReason {
  switch (section.state) {
    case 'no-definitions':
      return 'catalog-empty';
    case 'none-active':
      return 'none-published';
    case 'entries':
      return section.entries.find((entry) => entry.id === id) ?? 'definition-not-published';
  }
}

/**
 * FR-059 — the historical queue while it exists, the default otherwise.
 *
 * Resolved against the registry rather than against the row's own `queueName`,
 * because that label is what the queue was called when the row was composed and
 * this has to name a queue that can be enqueued into now. The unattributed
 * partition needs no special case: `__unattributed__` is never registered, so a
 * run filed under it substitutes by the same rule a deleted queue does.
 */
function resolveQueue(row: HistoryRow, queues: readonly QueueRuntime[] | undefined): RerunQueueTarget {
  const registry = queues ?? [];
  const historical = registry.find((queue) => queue.queueId === row.queueId);
  if (historical) {
    // `name || queueId` for the same reason `composeHistoryRows` uses it: the
    // projection can publish an empty name, and a notice reading "this will go
    // to the same queue: " names nothing.
    return { queueId: historical.queueId, name: historical.name || historical.queueId, substituted: false };
  }
  const fallback = registry.find((queue) => queue.queueId === DEFAULT_QUEUE_ID);
  // The bare id when the registry has not arrived. The default queue always
  // exists host-side — `validateQueueRegistry` asserts it — so this is a naming
  // gap in a loading window, not a claim that the queue is missing.
  return { queueId: DEFAULT_QUEUE_ID, name: fallback?.name || DEFAULT_QUEUE_ID, substituted: true };
}

/**
 * What repeating this row would do, resolved at the moment the form opens.
 *
 * Deliberately not memoised and not stored. The projection changes when a
 * version is published or retired, and a target remembered across that change
 * would offer a version that is no longer Active — the exact substitution
 * FR-034 forbids.
 */
export function resolveRerunTarget(
  row: HistoryRow,
  launchables: LaunchProjection | undefined,
  queues: readonly QueueRuntime[] | undefined
): RerunTarget {
  if (launchables === undefined) return { state: 'unavailable', reason: 'catalog-loading' };

  const version = row.catalogVersion;
  if (version === null) return { state: 'unavailable', reason: 'definition-not-recorded' };

  // Always the Pipelines section, never the Workflows one. A Workflow member's
  // frozen body is a Pipeline, so this is what makes FR-055 fall out rather
  // than needing a branch: the member resolves to its own Pipeline and the
  // graph is never reachable from here. The guard is for the shape the mirror
  // allows and the recorder does not write — a row whose frozen body was not a
  // Pipeline is not something this form can repeat, and looking its id up among
  // Pipelines would answer with the wrong definition or the wrong sentence.
  if (version.kind !== 'pipeline') return { state: 'unavailable', reason: 'not-a-pipeline-run' };

  const found = fromSection(launchables.pipelines, version.id);
  if (typeof found === 'string') return { state: 'unavailable', reason: found };

  return {
    state: 'ready',
    launchable: found,
    supersededVersionId: found.activeVersionId === version.versionId ? null : version.versionId,
    workflowMemberOf: row.origin?.kind === 'workflow-member' ? row.origin.workflowId : null,
    queue: resolveQueue(row, queues)
  };
}

/**
 * FR-037 — the stated reason. One sentence per arm, and no two alike.
 *
 * Kept beside the union rather than in the component so the exhaustiveness the
 * `switch` gives is checked by the compiler: a seventh reason cannot be added
 * without a seventh sentence.
 */
export function rerunUnavailableMessage(reason: RerunUnavailableReason): string {
  switch (reason) {
    case 'catalog-loading':
      return 'The published catalog is still loading, so this run cannot be repeated yet.';
    case 'definition-not-recorded':
      return 'This run recorded no version, so which definition it ran cannot be established.';
    case 'not-a-pipeline-run':
      return 'This run did not freeze a Pipeline, so it cannot be repeated from here.';
    case 'catalog-empty':
      return 'No Pipelines are in the catalog. Import a process document to repeat this run.';
    case 'none-published':
      return 'No Pipeline has a published version. Publish one to repeat this run.';
    case 'definition-not-published':
      return 'This run’s Pipeline has no published version, so there is nothing to repeat it against.';
  }
}
