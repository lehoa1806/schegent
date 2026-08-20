// Feature 082 (US1, T030) — Pipeline tab orchestration.
//
// Extracted from `PipelineBuilder.svelte`, which sits against the
// repository-wide 500-line Svelte budget. This module owns the reactive
// Pipeline rows, the single in-flight mutation, the revision handshake with the
// host, and the undo/redo history; the component keeps only the two `$effect`
// hooks (which must run in component context) and the template wiring.
//
// The mutation model mirrors the Phase catalog: exactly one declared mutation
// is in flight at a time, saves send the complete catalog, and a
// `stale-catalog` rejection rebases that single mutation onto the freshly
// projected records instead of clobbering a concurrent edit.
//
// Feature 099 (T494a, FR-043) — one layer, so one adopted revision and no
// `mutationScope`. The revision handshake is unchanged in every other respect:
// it is the expected-revision gate FR-047 keeps, now reading the store's
// manifest revision instead of a per-scope record.

import type { PipelineCatalogMutation, WorkflowSnapshot } from '../../lib/snapshot-types';
import { savePipelines as savePipelinesHelper } from '../../lib/save-pipelines';
import {
  formatPipelineSaveRejection,
  makeDuplicatePipelineDraft,
  makeNewPipelineDraft,
  rebasePipelineMutation,
  reorderPipelinePhases,
  sourceRecordToMutablePipeline,
  toSavePipelineRow
} from './pipeline-catalog-state';
import type { MutablePipeline } from './types';

export interface PipelineCatalogStoreOptions {
  readonly getSnapshot: () => WorkflowSnapshot;
  readonly onSaveError: (message: string) => void;
  readonly onSaveAccepted: () => void;
}

export class PipelineCatalogStore {
  pipelines = $state<MutablePipeline[]>([]);
  selectedIndex = $state<number | null>(null);
  newPhaseId = $state('');
  savePending = $state(false);
  mutation = $state<PipelineCatalogMutation | null>(null);
  mutationSourceKey = $state<string | null>(null);
  historyIndex = $state(-1);

  #history = $state<MutablePipeline[][]>([]);
  /** The revision the visible rows were projected from; '' before the first. */
  #adopted = $state('');
  #acceptedRevision = $state<string | null>(null);
  #staleRevision = $state<string | null>(null);
  #undoRedoInFlight = false;
  readonly #options: PipelineCatalogStoreOptions;

  constructor(options: PipelineCatalogStoreOptions) {
    this.#options = options;
  }

  get historyLength(): number {
    return this.#history.length;
  }

  get mutationActive(): boolean {
    return this.mutation !== null;
  }

  /**
   * Adopt the authoritative projection. A locally declared mutation holds the
   * rows steady until the host accepts it; only an untouched catalog, an
   * accepted save, or a rebase after `stale-catalog` replaces them.
   */
  syncFromSnapshot(snapshot: WorkflowSnapshot): void {
    const catalog = snapshot.pipelineCatalog;
    if (!catalog || catalog.state !== 'ready') return;
    const revision = catalog.revision;
    if (this.#staleRevision !== null && this.mutation && revision !== this.#adopted) {
      this.pipelines = rebasePipelineMutation(
        catalog.records,
        this.pipelines,
        this.mutation,
        this.mutationSourceKey
      );
      this.#adopted = revision;
      this.#staleRevision = null;
    }
    const acceptedRefresh = this.#acceptedRevision !== null && revision !== this.#adopted;
    const shouldAdopt = this.#adopted === '' || this.mutation === null || acceptedRefresh;
    if (revision === this.#adopted || !shouldAdopt) return;
    this.pipelines = catalog.records.map(sourceRecordToMutablePipeline);
    this.#adopted = revision;
    this.savePending = false;
    this.#clearMutation();
    this.selectedIndex = null;
  }

  /** Called from a component `$effect`; snapshots every settled row change. */
  recordHistory(): void {
    const current = JSON.stringify(this.pipelines);
    if (!this.#undoRedoInFlight) {
      const previous =
        this.historyIndex >= 0 ? JSON.stringify(this.#history[this.historyIndex]) : null;
      if (current !== previous) {
        this.#history = [...this.#history.slice(0, this.historyIndex + 1), JSON.parse(current)];
        this.historyIndex++;
      }
    }
    this.#undoRedoInFlight = false;
  }

  undo(): void {
    if (this.historyIndex <= 0) return;
    this.#undoRedoInFlight = true;
    this.historyIndex--;
    this.pipelines = JSON.parse(JSON.stringify(this.#history[this.historyIndex]));
  }

  redo(): void {
    if (this.historyIndex >= this.#history.length - 1) return;
    this.#undoRedoInFlight = true;
    this.historyIndex++;
    this.pipelines = JSON.parse(JSON.stringify(this.#history[this.historyIndex]));
  }

  add(): void {
    if (this.mutation) return;
    const draft = makeNewPipelineDraft(this.pipelines);
    this.pipelines = [...this.pipelines, draft];
    this.selectedIndex = this.pipelines.length - 1;
    this.#declare({ kind: 'create', pipelineId: draft.id }, draft);
  }

  duplicate(index: number): void {
    if (this.mutation) return;
    const original = this.pipelines[index];
    if (!original) return;
    const copy = makeDuplicatePipelineDraft(original, this.pipelines);
    const next = [...this.pipelines];
    next.splice(index + 1, 0, copy);
    this.pipelines = next;
    this.selectedIndex = index + 1;
    this.#declare(
      { kind: 'duplicate', sourcePipelineId: original.id, pipelineId: copy.id },
      copy
    );
  }

  /**
   * Feature 100 (T509b) — the confirmation moved into `deactivateDefinition`,
   * which is the only function that can post the command it authorises. This
   * method therefore no longer asks; it supplies what the prompt needs to say and
   * lets the helper raise it before dispatch (FR-049).
   */
  remove(index: number, originatingElement?: HTMLElement | null): void {
    const pipeline = this.pipelines[index];
    if (!pipeline || this.savePending) return;
    const proposed = this.pipelines.filter((_row, rowIndex) => rowIndex !== index);
    const mutation: PipelineCatalogMutation = { kind: 'remove', pipelineId: pipeline.id };
    this.mutation = mutation;
    this.mutationSourceKey = pipeline.sourceKey;
    this.#submit(mutation, proposed, {
      removedName: pipeline.name,
      originatingElement: originatingElement ?? null
    });
  }

  /** Drops an unsaved draft, or restores a persisted row from the projection. */
  discardDraft(index: number): void {
    const sourceKey = this.pipelines[index]?.sourceKey;
    const record = this.#options
      .getSnapshot()
      .pipelineCatalog?.records.find((candidate) => candidate.key === sourceKey);
    this.pipelines = record
      ? this.pipelines.map((row, rowIndex) =>
          rowIndex === index ? sourceRecordToMutablePipeline(record) : row
        )
      : this.pipelines.filter((_row, rowIndex) => rowIndex !== index);
    this.#clearMutation();
    this.selectedIndex = null;
  }

  update(index: number, patch: Partial<MutablePipeline>): void {
    const current = this.pipelines[index];
    if (!current || (this.mutationSourceKey && current.sourceKey !== this.mutationSourceKey)) return;
    this.pipelines = this.pipelines.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch } : row
    );
    const updated = this.pipelines[index];
    if (updated.persisted) {
      this.mutation = { kind: 'edit', pipelineId: current.id };
      this.mutationSourceKey = updated.sourceKey;
      return;
    }
    updated.sourceKey = `draft::${updated.id}`;
    if (this.mutation?.kind === 'create' && typeof patch.id === 'string') {
      this.mutation = { kind: 'create', pipelineId: patch.id };
    } else if (this.mutation?.kind === 'duplicate' && typeof patch.id === 'string') {
      this.mutation = { ...this.mutation, pipelineId: patch.id };
    }
    this.mutationSourceKey = updated.sourceKey;
  }

  setPhase(pipelineIndex: number, phaseIndex: number, phaseId: string): void {
    const pipeline = this.pipelines[pipelineIndex];
    if (!pipeline) return;
    this.update(pipelineIndex, {
      phases: pipeline.phases.map((id, position) => (position === phaseIndex ? phaseId : id))
    });
  }

  appendPhase(): void {
    const index = this.selectedIndex;
    const phaseId = this.newPhaseId.trim();
    if (index === null || phaseId.length === 0) return;
    this.update(index, { phases: [...this.pipelines[index].phases, phaseId] });
    this.newPhaseId = '';
  }

  removePhase(phaseIndex: number): void {
    const index = this.selectedIndex;
    if (index === null) return;
    this.update(index, {
      phases: this.pipelines[index].phases.filter((_id, position) => position !== phaseIndex)
    });
  }

  movePhaseUp(phaseIndex: number): void {
    this.#swapPhases(phaseIndex, phaseIndex - 1);
  }

  movePhaseDown(phaseIndex: number): void {
    this.#swapPhases(phaseIndex, phaseIndex + 1);
  }

  save(): void {
    if (this.mutation) this.#submit(this.mutation);
  }

  /**
   * US2 — a reorder must carry the binding `phaseIndex` remap with it, so this
   * goes through `reorderPipelinePhases` rather than swapping `phases` alone.
   */
  #swapPhases(from: number, to: number): void {
    const index = this.selectedIndex;
    const pipeline = index === null ? undefined : this.pipelines[index];
    if (index === null || !pipeline) return;
    const length = pipeline.phases.length;
    if (from < 0 || to < 0 || from >= length || to >= length) return;
    const { phases, bindings } = reorderPipelinePhases(pipeline, from, to);
    this.update(index, { phases, bindings });
  }

  #declare(mutation: PipelineCatalogMutation, draft: MutablePipeline): void {
    this.mutation = mutation;
    this.mutationSourceKey = draft.sourceKey;
  }

  #clearMutation(): void {
    this.mutation = null;
    this.mutationSourceKey = null;
    this.#acceptedRevision = null;
    this.#staleRevision = null;
  }

  #submit(
    mutation: PipelineCatalogMutation,
    sourceRows: readonly MutablePipeline[] = this.pipelines,
    prompt: { removedName?: string; originatingElement?: HTMLElement | null } = {}
  ): void {
    const catalog = this.#options.getSnapshot().pipelineCatalog;
    if (!catalog || catalog.state !== 'ready' || this.savePending) return;
    const pipelines = sourceRows.map(toSavePipelineRow);
    this.savePending = true;
    this.#acceptedRevision = null;
    void savePipelinesHelper({
      expectedRevision: this.#adopted,
      mutation,
      pipelines,
      ...prompt
    }).then((result) => {
      if (result.status === 'rejected') {
        this.savePending = false;
        // Feature 100 (T509b) — the operator closed the removal prompt. Nothing
        // was sent and nothing failed, so the editor returns to where it was
        // instead of reporting an error it would have to invent.
        if (result.reason === 'declined') {
          this.#clearMutation();
          return;
        }
        const stale = result.result as { currentRevision?: unknown } | undefined;
        if (result.reason === 'stale-catalog' && typeof stale?.currentRevision === 'string') {
          this.#staleRevision = stale.currentRevision;
        }
        this.#options.onSaveError(formatPipelineSaveRejection(result.reason, result.result));
        return;
      }
      this.#options.onSaveAccepted();
      const accepted = result.result as { revision?: string } | undefined;
      this.#acceptedRevision = accepted?.revision ?? '';
      // An accepted save whose revision already matches the projection means no
      // further snapshot is coming; settle now instead of waiting for one.
      if (this.#acceptedRevision === catalog.revision) {
        this.savePending = false;
        this.#clearMutation();
      }
    });
  }
}
