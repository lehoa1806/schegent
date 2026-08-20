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
import {
  deactivateDefinition,
  draftTokenOfRecord,
  saveDefinitionDraft,
  type LifecycleResult
} from '../../lib/catalog-lifecycle';
import { pipelineRowId } from '../../lib/definition-rows';
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
  // Feature 101 (T027) — booleans, not revision strings. A lifecycle ack carries
  // no revision, and what the handshake below has always read out of these two is
  // "a write landed" and "the last write was refused as stale".
  #saveAccepted = $state(false);
  #rebasePending = $state(false);
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
    if (this.#rebasePending && this.mutation && revision !== this.#adopted) {
      this.pipelines = rebasePipelineMutation(
        catalog.records,
        this.pipelines,
        this.mutation,
        this.mutationSourceKey
      );
      this.#adopted = revision;
      this.#rebasePending = false;
    }
    const acceptedRefresh = this.#saveAccepted && revision !== this.#adopted;
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
    const catalog = this.#options.getSnapshot().pipelineCatalog;
    const pipeline = this.pipelines[index];
    if (!pipeline || this.savePending || catalog?.state !== 'ready') return;
    const record = catalog.records.find((candidate) => candidate.key === pipeline.sourceKey);
    this.mutation = { kind: 'remove', pipelineId: pipeline.id };
    this.mutationSourceKey = pipeline.sourceKey;
    this.#submit(() =>
      deactivateDefinition(
        { kind: 'pipeline', id: pipeline.id, expectedDraftVersion: draftTokenOfRecord(record) },
        { definitionName: pipeline.name, originatingElement: originatingElement ?? null }
      )
    );
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

  /**
   * FR-026a — save writes a DRAFT of the one edited Pipeline.
   *
   * The row is found by source key rather than by id because the id is itself an
   * editable field. `pipelineRowId` picks between the two authored identity
   * spellings the host validator accepts; a row declaring neither is not
   * addressable and is refused here rather than sent under an empty id.
   */
  save(): void {
    const catalog = this.#options.getSnapshot().pipelineCatalog;
    if (!this.mutation || catalog?.state !== 'ready') return;
    const row = this.pipelines.find((candidate) => candidate.sourceKey === this.mutationSourceKey);
    if (!row) return;
    const body = toSavePipelineRow(row);
    const id = pipelineRowId(body);
    if (id.length === 0) return;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    this.#submit(() =>
      saveDefinitionDraft({
        kind: 'pipeline',
        id,
        expectedDraftVersion: draftTokenOfRecord(record),
        body
      })
    );
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
    this.#saveAccepted = false;
    this.#rebasePending = false;
  }

  /**
   * Feature 101 (T027, FR-026a) — one lifecycle write, sent and settled.
   *
   * `send` is a thunk rather than a request: a draft save is ungated and a
   * deactivation raises its confirmation inside the helper (FR-049), so the two
   * writers share only the pending gate, the refusal handling, and when to stop
   * waiting. That is what this method is.
   */
  #submit(send: () => Promise<LifecycleResult>): void {
    if (this.savePending) return;
    this.savePending = true;
    this.#saveAccepted = false;
    void send().then((result) => {
      if (result.status === 'rejected') {
        this.savePending = false;
        // Feature 100 (T509b) — the operator closed the removal prompt. Nothing
        // was sent and nothing failed, so the editor returns to where it was
        // instead of reporting an error it would have to invent.
        if (result.reason === 'declined') {
          this.#clearMutation();
          return;
        }
        if (result.reason === 'stale-catalog') this.#rebasePending = true;
        this.#options.onSaveError(formatPipelineSaveRejection(result.reason, result.result));
        return;
      }
      this.#options.onSaveAccepted();
      this.#saveAccepted = true;
      // FR-026d — an unchanged save is a success that writes nothing, so the
      // projection will not move and no snapshot is coming. Settle now, or every
      // control stays disabled until the view is reloaded.
      if ((result.result as { appended?: boolean } | undefined)?.appended === false) {
        this.savePending = false;
        this.#clearMutation();
      }
    });
  }
}
