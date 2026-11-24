/**
 * FR-R8-01 (01-04) — Named cancellation target for a Workflow Phase leaf.
 *
 * Replaces positional `(string, string)` parameter pairs across the coordinator,
 * composition, control service, leaf-control adapter, and leaf settlement so
 * `queueId` and `taskId` cannot be swapped silently at compile time.
 */
export interface WorkflowLeafTarget {
  readonly queueId: string;
  /** The attempt's `queueItemId`: the queue row id and the `featureId` of any Run it started. */
  readonly taskId: string;
}

