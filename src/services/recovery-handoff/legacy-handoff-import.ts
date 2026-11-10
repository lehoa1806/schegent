/**
 * FR-R6-F08 (FR-019, research R11, US5 scenario 3) — importing a record captured before the
 * cutover.
 *
 * The record is mapped by `mapLegacyRecord`. A mapped preparation goes through `prepare`
 * unchanged, so an import is idempotent and its references are pinned as any other; a paused
 * record is then paused. A record whose envelope version this build does not know is stored as
 * an `unsupported` handoff with no revision: it keeps the record's identity, resolves
 * `unsupported-version`, and its owner still resolves `live`, so nothing it references is
 * collected. Importing it again returns the same row; importing it over a live handoff under the
 * same lineage is `conflict`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { HandoffRefusal } from '../../contracts/recovery-handoff/handoff-types';
import { setHandoffPaused, type SetPausedResult } from './handoff-operator';
import { handoffIdFor } from './handoff-identity';
import { isNewerBuildStore } from './handoff-pins';
import { prepareRevision, type HandoffWriteDeps, type PrepareResult } from './handoff-prepare';
import { mapLegacyRecord, type LegacyHandoffRecord, type LegacyMapping } from './legacy-handoff-mapping';

export type ImportLegacyResult =
  | PrepareResult
  | { readonly ok: true; readonly handoffId: string; readonly state: 'unsupported' }
  | (HandoffRefusal<'invalid'> & { readonly field: string })
  | HandoffRefusal<'conflict'>
  | Exclude<SetPausedResult, { readonly ok: true }>;

function storeUnsupported(
  deps: HandoffWriteDeps,
  mapping: Extract<LegacyMapping, { readonly kind: 'unsupported' }>
): ImportLegacyResult {
  if (isNewerBuildStore(deps.conn)) return { ok: false, code: 'unsupported-version' };
  const { store } = deps;
  const handoffId = handoffIdFor(mapping.lineage);
  return store.transaction((): ImportLegacyResult => {
    const existing = store.getHandoff(handoffId);
    if (existing !== undefined) {
      if (existing.state !== 'unsupported') return { ok: false, code: 'conflict' };
      return { ok: true, handoffId, state: 'unsupported' };
    }
    const nowMs = deps.nowMs();
    store.insertHandoff({ handoffId, ...mapping.lineage, legacyProvenance: mapping.legacyProvenance, nowMs });
    store.updateHandoff(handoffId, { state: 'unsupported' }, nowMs);
    return { ok: true, handoffId, state: 'unsupported' };
  });
}

/** Contract `importLegacy`. */
export function importLegacyRecord(deps: HandoffWriteDeps, record: LegacyHandoffRecord): ImportLegacyResult {
  const mapping = mapLegacyRecord(record);
  if (mapping.kind === 'invalid') return { ok: false, code: 'invalid', field: mapping.field };
  if (mapping.kind === 'unsupported') return storeUnsupported(deps, mapping);
  const prepared = prepareRevision(deps, mapping.lineage, mapping.cutoff, mapping.manifest, mapping.legacyProvenance);
  if (!prepared.ok || !mapping.paused) return prepared;
  const paused = setHandoffPaused(deps, prepared.handoffId, true);
  return paused.ok ? prepared : paused;
}
