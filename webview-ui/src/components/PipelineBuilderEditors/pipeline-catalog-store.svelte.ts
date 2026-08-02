// Feature 082 (US1, T030) — Pipeline tab orchestration.
//
// Extracted from `PipelineBuilder.svelte`, which sits against the
// repository-wide 500-line Svelte budget. This module owns the reactive
// Pipeline rows, the single in-flight mutation, the revision handshake with the
// host, and the undo/redo history; the component keeps only the two `$effect`
// hooks (which must run in component context) and the template wiring.
//
// The mutation model mirrors the Phase catalog: exactly one declared mutation
// is in flight at a time, saves send the complete layer for one scope, and a
// `stale-catalog` rejection rebases that single mutation onto the freshly
// projected records instead of clobbering a concurrent edit.

import type {
  PipelineCatalogMutation,
  WorkflowSnapshot,
  WritablePipelineDefinitionScope
} from '../../lib/snapshot-types';
import { savePipelines as savePipelinesHelper } from '../../lib/save-pipelines';
import { useConfirm } from '../../lib/use-confirm';
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

type Revisions = Record<WritablePipelineDefinitionScope, string>;

export class PipelineCatalogStore {
  pipelines = $state<MutablePipeline[]>([]);
  selectedIndex = $state<number | null>(null);
  newPhaseId = $state('');
  savePending = $state(false);
  mutation = $state<PipelineCatalogMutation | null>(null);
  mutationScope = $state<WritablePipelineDefinitionScope | null>(null);
  mutationSourceKey = $state<string | null>(null);
  historyIndex = $state(-1);

  #history = $state<MutablePipeline[][]>([]);
  #adopted = $state<Revisions>({ user: '', workspace: '' });
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
    const revisionKey = `${catalog.revisions.user}:${catalog.revisions.workspace}`;
    const adoptedKey = `${this.#adopted.user}:${this.#adopted.workspace}`;
    const scope = this.mutationScope;
    if (
      this.#staleRevision !== null &&
      this.mutation &&
      scope &&
      catalog.revisions[scope] !== this.#adopted[scope]
    ) {
      this.pipelines = rebasePipelineMutation(
        catalog.records,
        this.pipelines,
        this.mutation,
        scope,
        this.mutationSourceKey
      );
      this.#adopted = { ...catalog.revisions };
      this.#staleRevision = null;
    }
    const acceptedRefresh =
      this.#acceptedRevision !== null && scope !== null &&
      catalog.revisions[scope] !== this.#adopted[scope];
    const shouldAdopt = adoptedKey === ':' || this.mutation === null || acceptedRefresh;
    if (revisionKey === adoptedKey || !shouldAdopt) return;
    this.pipelines = catalog.records.map(sourceRecordToMutablePipeline);
    this.#adopted = { ...catalog.revisions };
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
      {
        kind: 'duplicate',
        sourceScope: original.scope,
        sourcePipelineId: original.id,
        pipelineId: copy.id
      },
      copy
    );
  }

  async remove(index: number, originatingElement?: HTMLElement | null): Promise<void> {
    const pipeline = this.pipelines[index];
    if (!pipeline || pipeline.scope === 'built-in' || this.savePending) return;
    const scope = pipeline.scope;
    const confirmed = await useConfirm('catalog.remove-pipeline', {
      originatingElement,
      context: { pipelineName: pipeline.name, pipelineId: pipeline.id, scope }
    });
    if (!confirmed) return;
    const proposed = this.pipelines.filter((_row, rowIndex) => rowIndex !== index);
    const mutation: PipelineCatalogMutation = { kind: 'remove', pipelineId: pipeline.id };
    this.mutation = mutation;
    this.mutationScope = scope;
    this.mutationSourceKey = pipeline.sourceKey;
    this.#submit(mutation, scope, proposed);
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
    if (!updated.persisted) updated.sourceKey = `draft::${updated.scope}::${updated.id}`;
    if (updated.persisted && updated.scope !== 'built-in') {
      this.mutation = { kind: 'edit', pipelineId: current.id };
      this.mutationScope = updated.scope;
      this.mutationSourceKey = updated.sourceKey;
      return;
    }
    if (this.mutation?.kind === 'create' && typeof patch.id === 'string') {
      this.mutation = { kind: 'create', pipelineId: patch.id };
    } else if (this.mutation?.kind === 'duplicate' && typeof patch.id === 'string') {
      this.mutation = { ...this.mutation, pipelineId: patch.id };
    }
    if (!updated.persisted && updated.scope !== 'built-in') {
      this.mutationScope = updated.scope;
      this.mutationSourceKey = updated.sourceKey;
    }
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
    if (this.mutation && this.mutationScope) this.#submit(this.mutation, this.mutationScope);
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
    this.mutationScope = draft.scope === 'built-in' ? 'workspace' : draft.scope;
    this.mutationSourceKey = draft.sourceKey;
  }

  #clearMutation(): void {
    this.mutation = null;
    this.mutationScope = null;
    this.mutationSourceKey = null;
    this.#acceptedRevision = null;
    this.#staleRevision = null;
  }

  #submit(
    mutation: PipelineCatalogMutation,
    scope: WritablePipelineDefinitionScope,
    sourceRows: readonly MutablePipeline[] = this.pipelines
  ): void {
    const catalog = this.#options.getSnapshot().pipelineCatalog;
    if (!catalog || catalog.state !== 'ready' || this.savePending) return;
    const pipelines = sourceRows
      .filter((row) => row.scope === scope)
      .map(toSavePipelineRow);
    this.savePending = true;
    this.#acceptedRevision = null;
    void savePipelinesHelper({
      scope,
      expectedRevision: this.#adopted[scope],
      mutation,
      pipelines
    }).then((result) => {
      if (result.status === 'rejected') {
        this.savePending = false;
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
      if (this.#acceptedRevision === catalog.revisions[scope]) {
        this.savePending = false;
        this.#clearMutation();
      }
    });
  }
}
