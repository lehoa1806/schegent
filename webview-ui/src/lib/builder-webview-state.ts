// FR-R5-F10 (NF-11, NU-06, NF-14) — versioned, bounded Builder draft persistence
// in VS Code webview state (`getWebviewState` / `setWebviewState`), merged
// non-destructively alongside the Phase Log slice (`isLiveMode`).

import * as vscodeApi from './vscode-api';
import { identityAt, reselectIndex } from './builder-selection';
import {
  boundHistorySnapshots,
  MAX_BUILDER_HISTORY_BYTES,
  MAX_BUILDER_HISTORY_ENTRIES
} from '../components/PipelineBuilderEditors/phase-catalog-actions';
import {
  rebasePhaseMutation,
  sourceRecordToMutable,
  type PhaseCatalogMutation
} from '../components/PipelineBuilderEditors/phase-catalog-state';
import type { WorkflowHistoryTrack } from '../components/PipelineBuilderEditors/workflow-catalog-actions';
import type { WorkflowBreadcrumbEntry } from '../components/PipelineBuilderEditors/WorkflowFlowTopBar.svelte';
import type {
  BuilderTab,
  MutablePhase,
  MutableWorkflow,
  PhaseEditState
} from '../components/PipelineBuilderEditors/types';
import type { WorkflowSnapshot } from './snapshot-types';

export const BUILDER_WEBVIEW_STATE_VERSION = 1 as const;
export const BUILDER_STATE_KEY = 'builderState' as const;

export interface PersistedPhaseBuilderSlice {
  readonly adoptedRevision: string;
  readonly phases: MutablePhase[];
  readonly selectedIndex: number | null;
  readonly mutation: PhaseCatalogMutation | null;
  readonly mutationSourceKey: string | null;
  readonly history: MutablePhase[][];
  readonly historyIndex: number;
  readonly editStateById: Record<string, PhaseEditState>;
}

export interface PersistedWorkflowBuilderSlice {
  readonly adoptedRevision: string;
  readonly drafts: MutableWorkflow[];
  readonly editedByKey: Record<string, MutableWorkflow>;
  readonly historyByKey: Record<string, WorkflowHistoryTrack>;
  readonly selectedKey: string | null;
  readonly selectedId: string | null;
  readonly breadcrumbs: WorkflowBreadcrumbEntry[];
  readonly restoredNodeId: string | null;
}

export interface PersistedBuilderState {
  readonly version: typeof BUILDER_WEBVIEW_STATE_VERSION;
  readonly activeTab?: BuilderTab;
  readonly pendingWorkflowId?: string | null;
  readonly phaseSlice?: PersistedPhaseBuilderSlice | null;
  readonly workflowSlice?: PersistedWorkflowBuilderSlice | null;
}

function safeReadEnvelope(): Record<string, unknown> {
  try {
    if (typeof vscodeApi.getWebviewState !== 'function') return {};
    const raw = vscodeApi.getWebviewState<unknown>();
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // Ignore host transport errors in non-webview test realms.
  }
  return {};
}

function safeWriteEnvelope(next: Record<string, unknown>): void {
  try {
    if (typeof vscodeApi.setWebviewState !== 'function') return;
    vscodeApi.setWebviewState(next);
  } catch {
    // Ignore host transport errors in non-webview test realms.
  }
}

function isBuilderTab(value: unknown): value is BuilderTab {
  return value === 'phases' || value === 'workflows' || value === 'models';
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function readPersistedBuilderState(): PersistedBuilderState | null {
  const envelope = safeReadEnvelope();
  const candidate = envelope[BUILDER_STATE_KEY];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (record.version !== BUILDER_WEBVIEW_STATE_VERSION) return null;
  return {
    version: BUILDER_WEBVIEW_STATE_VERSION,
    ...(isBuilderTab(record.activeTab) ? { activeTab: record.activeTab } : {}),
    ...(typeof record.pendingWorkflowId === 'string' || record.pendingWorkflowId === null
      ? { pendingWorkflowId: record.pendingWorkflowId }
      : {}),
    ...(typeof record.phaseSlice === 'object' && record.phaseSlice !== null
      ? { phaseSlice: plainClone(record.phaseSlice as PersistedPhaseBuilderSlice) }
      : {}),
    ...(typeof record.workflowSlice === 'object' && record.workflowSlice !== null
      ? { workflowSlice: plainClone(record.workflowSlice as PersistedWorkflowBuilderSlice) }
      : {})
  };
}

export function updatePersistedBuilderState(
  patch: Partial<Omit<PersistedBuilderState, 'version'>>
): void {
  const envelope = safeReadEnvelope();
  const current = readPersistedBuilderState() ?? { version: BUILDER_WEBVIEW_STATE_VERSION };
  const next: PersistedBuilderState = {
    ...current,
    ...patch,
    version: BUILDER_WEBVIEW_STATE_VERSION
  };
  safeWriteEnvelope({
    ...envelope,
    [BUILDER_STATE_KEY]: next
  });
}

export function writePersistedPhaseSlice(slice: PersistedPhaseBuilderSlice): void {
  const boundedHistory = boundHistorySnapshots(
    slice.history,
    MAX_BUILDER_HISTORY_ENTRIES,
    MAX_BUILDER_HISTORY_BYTES
  );
  const indexDelta = slice.history.length - boundedHistory.length;
  const boundedIndex =
    boundedHistory.length === 0
      ? -1
      : Math.max(0, Math.min(boundedHistory.length - 1, slice.historyIndex - indexDelta));
  updatePersistedBuilderState({
    phaseSlice: plainClone({
      ...slice,
      history: boundedHistory,
      historyIndex: boundedIndex
    })
  });
}

export function hydratePhaseSlice(
  persisted: PersistedPhaseBuilderSlice,
  snapshot: WorkflowSnapshot
): PersistedPhaseBuilderSlice {
  const catalog = snapshot.phaseCatalog;
  if (catalog?.state !== 'ready') return persisted;
  if (catalog.revision === persisted.adoptedRevision) return persisted;
  const phaseIdentity = (row: MutablePhase) => ({ sourceKey: row.sourceKey, id: row.id });
  const openPhase = identityAt(persisted.phases, persisted.selectedIndex, phaseIdentity);
  if (persisted.mutation !== null) {
    const rebased = rebasePhaseMutation(
      catalog.records,
      persisted.phases,
      persisted.mutation,
      persisted.mutationSourceKey
    );
    const stillHasDraft = rebased.some((row) => row.sourceKey === persisted.mutationSourceKey);
    const boundedHistory = boundHistorySnapshots([...persisted.history, rebased]);
    return {
      adoptedRevision: catalog.revision,
      phases: rebased,
      selectedIndex: reselectIndex(rebased, openPhase, phaseIdentity),
      mutation: stillHasDraft ? persisted.mutation : null,
      mutationSourceKey: stillHasDraft ? persisted.mutationSourceKey : null,
      history: boundedHistory,
      historyIndex: boundedHistory.length - 1,
      editStateById: persisted.editStateById
    };
  }
  const fresh = catalog.records.map(sourceRecordToMutable);
  return {
    adoptedRevision: catalog.revision,
    phases: fresh,
    selectedIndex: reselectIndex(fresh, openPhase, phaseIdentity),
    mutation: null,
    mutationSourceKey: null,
    history: [plainClone(fresh)],
    historyIndex: 0,
    editStateById: persisted.editStateById
  };
}

export function writePersistedWorkflowSlice(slice: PersistedWorkflowBuilderSlice): void {
  const boundedTracks: Record<string, WorkflowHistoryTrack> = {};
  for (const [key, track] of Object.entries(slice.historyByKey)) {
    const bounded = boundHistorySnapshots(
      track.snapshots,
      MAX_BUILDER_HISTORY_ENTRIES,
      MAX_BUILDER_HISTORY_BYTES
    );
    const delta = track.snapshots.length - bounded.length;
    boundedTracks[key] = {
      snapshots: bounded,
      index: Math.max(0, Math.min(bounded.length - 1, track.index - delta))
    };
  }
  updatePersistedBuilderState({
    workflowSlice: plainClone({
      ...slice,
      historyByKey: boundedTracks
    })
  });
}

export function hydrateWorkflowSlice(
  persisted: PersistedWorkflowBuilderSlice,
  snapshot: WorkflowSnapshot
): PersistedWorkflowBuilderSlice {
  const catalog = snapshot.workflowCatalog;
  if (catalog?.state !== 'ready') return persisted;
  if (catalog.revision === persisted.adoptedRevision) return persisted;
  const activeKeys = new Set(catalog.records.map((r) => r.key));
  const nextEdited: Record<string, MutableWorkflow> = {};
  for (const [key, edited] of Object.entries(persisted.editedByKey)) {
    if (activeKeys.has(key)) nextEdited[key] = edited;
  }
  const draftKeys = new Set(persisted.drafts.map((d) => d.sourceKey));
  const nextHistory: Record<string, WorkflowHistoryTrack> = {};
  for (const [key, track] of Object.entries(persisted.historyByKey)) {
    if (activeKeys.has(key) || draftKeys.has(key)) nextHistory[key] = track;
  }
  return {
    ...persisted,
    adoptedRevision: catalog.revision,
    editedByKey: nextEdited,
    historyByKey: nextHistory
  };
}
