/**
 * Repairing an invalid Pipeline must not empty its phase list.
 *
 * WHY THIS EXISTS. `sourceRecordToMutablePipeline` reads the phase list off
 * `display` when a record has no parsed definition, under a comment giving the
 * reason: "falling back to an empty row would silently discard what they typed". It
 * did fall back to an empty row, twice over:
 *
 *   1. `display` could not carry a list at all — every catalog validator's display
 *      map admitted scalars only, and the sidebar projection dropped lists again on
 *      the way to the webview. Both halves are pinned host-side
 *      (`tests/unit/config/authored-display-carries-arrays.test.ts`,
 *      `tests/unit/ui/sidebar/invalid-row-display-carries-lists.test.ts`).
 *   2. It read only the legacy `phases` key. `phaseIds` is the portable spelling and
 *      the one the validator prefers, so a Pipeline authored the recommended way
 *      opened for repair with no phases even once `display` could carry them.
 *
 * The consequence is the same either way and it is not recoverable by looking again:
 * the operator opens a broken Pipeline to fix its name, the editor shows an empty
 * phase list, and saving that writes the empty list back.
 */

import { describe, expect, it } from 'vitest';
import {
  sourceRecordToMutablePipeline,
  toSavePipelineRow
} from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { PipelineCatalogSourceRecord } from '../../lib/snapshot-types';

/** An invalid record: no definition, so `display` is all the row has to go on. */
function invalidRecord(display: Record<string, unknown>): PipelineCatalogSourceRecord {
  return {
    key: 'broken::0',
    pipelineId: 'broken',
    status: 'invalid',
    definition: null,
    display: { name: '', version: 1, ...display },
    errors: [{ field: 'name', code: 'invalid-length', message: 'Pipeline name is required' }]
  } as unknown as PipelineCatalogSourceRecord;
}

describe('an invalid Pipeline opens for repair with the phases it declared', () => {
  it('recovers a legacy `phases` list', () => {
    const row = sourceRecordToMutablePipeline(invalidRecord({ phases: ['plan', 'build'] }));
    expect(row.phases).toEqual(['plan', 'build']);
  });

  it('recovers a portable `phaseIds` list', () => {
    const row = sourceRecordToMutablePipeline(invalidRecord({ phaseIds: ['plan', 'build'] }));
    expect(row.phases).toEqual(['plan', 'build']);
  });

  it('prefers `phaseIds` over `phases`, as the validator does', () => {
    // A body carrying both is `sequence-ambiguous` and therefore invalid, so this
    // path does see it. Showing the portable key matches which one the validator
    // would have parsed had the row been otherwise sound.
    const row = sourceRecordToMutablePipeline(
      invalidRecord({ phaseIds: ['portable'], phases: ['legacy'] })
    );
    expect(row.phases).toEqual(['portable']);
  });

  it('carries the recovered list into the save body rather than writing an empty one', () => {
    // The end of the round trip, which is where the loss actually cost something:
    // an empty list here overwrites the operator's phases on a save they were told
    // succeeded.
    const row = sourceRecordToMutablePipeline(invalidRecord({ phaseIds: ['plan', 'build'] }));
    const body = toSavePipelineRow(row) as unknown as Record<string, unknown>;
    expect(body.phases).toEqual(['plan', 'build']);
  });

  it('opens with an empty list when the row declared no recoverable phases', () => {
    // Not a fallback worth preserving — just the truth when there is nothing to show.
    expect(sourceRecordToMutablePipeline(invalidRecord({})).phases).toEqual([]);
    expect(
      sourceRecordToMutablePipeline(invalidRecord({ phases: 'plan' })).phases,
      'a string is not a phase list'
    ).toEqual([]);
  });

  it('keeps reading a valid record from its definition', () => {
    // The guard on the whole change: `display` is the invalid-row path and must not
    // become a second source of truth for a row that parsed.
    const record = {
      key: 'ok::0',
      pipelineId: 'ok',
      status: 'effective',
      definition: {
        pipelineId: 'ok',
        name: 'Ok',
        version: 1,
        phaseIds: ['plan'],
        inputs: [],
        outputs: [],
        bindings: [],
        recommendedNext: []
      },
      display: { name: 'Ok', version: 1, phaseIds: ['stale', 'wrong'] },
      errors: []
    } as unknown as PipelineCatalogSourceRecord;

    expect(sourceRecordToMutablePipeline(record).phases).toEqual(['plan']);
  });
});
