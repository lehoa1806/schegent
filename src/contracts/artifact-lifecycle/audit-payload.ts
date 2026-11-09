import type { PreviewKind } from './lifecycle-types';

/**
 * FR-R6-F05 (FR-022) — the payload of one `artifact-lifecycle-mutation` audit row. Metadata only: the
 * mutation kind, its opaque operation id, bounded counts and the result. No artifact id, path, digest,
 * display name or content can be represented, so a row can never disclose what was removed.
 */
export interface ArtifactLifecycleMutationPayload {
  readonly operationKind: PreviewKind;
  readonly operationId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly result: 'completed' | 'partial' | 'refused' | 'resumed';
}
