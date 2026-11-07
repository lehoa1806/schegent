// FR-R5-F10 (NF-14) — the bounded undo/redo history policy shared by the Phase and
// Workflow editors, re-exported by `PipelineBuilderEditors/phase-catalog-actions.ts`.
//
// This module imports nothing, so the host type-check (Node16 resolution) can load it
// from `tests/perf/webview-snapshot-cost.test.ts` without the Builder's import graph.

/**
 * FR-R5-F10 (NF-14) — bounded undo/redo history policy for Phase and Workflow
 * editors. Caps both entry count and total serialized JSON bytes so long
 * authoring sessions stay within webview `setState` memory bounds while
 * preserving branching after undo, at least the newest step, and a coherent
 * cursor index when oldest snapshots are evicted.
 */
export const MAX_BUILDER_HISTORY_ENTRIES = 50;
export const MAX_BUILDER_HISTORY_BYTES = 262_144;

function utf8ByteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

export function boundHistorySnapshots<T>(
  snapshots: readonly T[],
  maxEntries = MAX_BUILDER_HISTORY_ENTRIES,
  maxBytes = MAX_BUILDER_HISTORY_BYTES
): T[] {
  if (snapshots.length === 0) return [];
  const entryCap = Math.max(1, maxEntries);
  let start = Math.max(0, snapshots.length - entryCap);
  const sizes = snapshots.map((item) => utf8ByteLength(JSON.stringify(item)));
  let totalBytes = 0;
  for (let i = start; i < sizes.length; i++) totalBytes += sizes[i] ?? 0;
  while (start < snapshots.length - 1 && totalBytes > maxBytes) {
    totalBytes -= sizes[start] ?? 0;
    start++;
  }
  return snapshots.slice(start);
}
