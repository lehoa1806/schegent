// FR-R3-130 (T1495) — the cap warning's model, and the record it reads.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PER_STREAM_ACCEPTED_CAP_BYTES,
  RETAINED_PER_ACCEPTED_BYTE,
  STREAMS_PER_RUN,
  WARN_AT_MACHINE_MEMORY_SHARE,
  adviseStreamPressure
} from '../../../src/contracts/stream-pressure-advice';
import { MAX_STREAM_BUFFER_BYTES } from '../../../src/runner/zipped-stream-buffer';

const GIB = 1024 * 1024 * 1024;

describe('adviseStreamPressure (FR-R3-130)', () => {
  it('mirrors the per-stream cap the runner enforces', () => {
    // Two copies of a bound is how the two come to disagree. This module cannot
    // import the runner's constant — `contracts/` may not value-import an acting
    // layer (`dependency-direction.test.ts`) — so the mirror is asserted instead.
    expect(PER_STREAM_ACCEPTED_CAP_BYTES).toBe(MAX_STREAM_BUFFER_BYTES);
  });

  it('reads its coefficient from the measurement record, not from a keyboard', () => {
    // `FR-R3-081` ruled that mechanism work on this bound must be argued from
    // measurement. A coefficient nobody can trace back is that ruling's arithmetic
    // wearing a warning's clothes — so the record must state the number this module
    // uses, and a stale record fails here rather than misleading an operator.
    const record = readFileSync(
      resolve(__dirname, '../../../docs/operations/large-workspace-resource-measurement.md'),
      'utf8'
    );
    expect(record).toContain('The coefficient is **1.0**');
    expect(RETAINED_PER_ACCEPTED_BYTE).toBe(1.0);
    // And the record must still say why the heap column is not the source, because
    // that is the correction the second measurement run produced.
    expect(record).toMatch(/UNUSABLE as a coefficient/);
  });

  it('is silent at the shipped default on any ordinary machine', () => {
    // cap 1 x 2 streams x 64 MiB = 128 MiB. On 8 GiB that is 1.6% — a warning here
    // would fire on every fresh install, which is how a warning becomes furniture.
    for (const memory of [8 * GIB, 16 * GIB, 64 * GIB]) {
      const advice = adviseStreamPressure({ cap: 1, machineMemoryBytes: memory });
      expect(advice.level, `${memory / GIB} GiB`).toBe('ok');
    }
  });

  it('warns when the projection crosses a quarter of machine memory', () => {
    // 8 GiB machine: the threshold is 2 GiB, and 2 GiB / (2 x 64 MiB) = 16 Runs.
    const small = (cap: number) => adviseStreamPressure({ cap, machineMemoryBytes: 8 * GIB });
    expect(small(15).level).toBe('ok');
    expect(small(16).level).toBe('warn');

    // 64 GiB machine: the same cap is 3% and silent. The threshold is
    // machine-derived, which is the whole point — an operator on a large machine is
    // making a legitimate choice and should not be told otherwise.
    expect(adviseStreamPressure({ cap: 16, machineMemoryBytes: 64 * GIB }).level).toBe('ok');
    expect(adviseStreamPressure({ cap: 20, machineMemoryBytes: 4 * GIB }).level).toBe('warn');
  });

  it('the warning names the projection, the share, and where the number came from', () => {
    const advice = adviseStreamPressure({ cap: 20, machineMemoryBytes: 8 * GIB });
    expect(advice.level).toBe('warn');
    if (advice.level !== 'warn') return;
    expect(advice.message).toContain('cap of 20');
    expect(advice.message).toMatch(/\d+ MiB/);
    expect(advice.message).toMatch(/\d+% of this machine/);
    // The operator's next move is the record, and a warning that cannot be checked
    // is a warning that gets dismissed.
    expect(advice.message).toContain('large-workspace-resource-measurement.md');
    // And it must say the cap is still allowed: this warns, it does not refuse, and
    // the ratified range is not this module's to narrow.
    expect(advice.message).toMatch(/still permitted/);
  });

  it('takes the operator workload as an input rather than assuming the cap', () => {
    // A phase producing 1 MiB per stream is a different machine-load question from
    // one producing 64. Defaulting to the cap warns against the bound the product
    // permits; supplying a measured figure warns against reality.
    const worstCase = adviseStreamPressure({ cap: 16, machineMemoryBytes: 8 * GIB });
    const measured = adviseStreamPressure({
      cap: 16,
      machineMemoryBytes: 8 * GIB,
      expectedStreamBytes: 1024 * 1024
    });
    expect(worstCase.level).toBe('warn');
    expect(measured.level).toBe('ok');
    expect(measured.projectedResidentBytes).toBeLessThan(worstCase.projectedResidentBytes);

    // An expectation above the cap is clamped to it: the buffer cannot accept more.
    const absurd = adviseStreamPressure({
      cap: 1,
      machineMemoryBytes: 8 * GIB,
      expectedStreamBytes: 10 * PER_STREAM_ACCEPTED_CAP_BYTES
    });
    expect(absurd.projectedResidentBytes).toBe(
      Math.round(1 * STREAMS_PER_RUN * PER_STREAM_ACCEPTED_CAP_BYTES * RETAINED_PER_ACCEPTED_BYTE)
    );
  });

  it('does not warn about a machine that did not answer', () => {
    // `os.totalmem()` returning 0 would otherwise make every cap look catastrophic,
    // and a warning derived from an absent fact is worse than silence.
    for (const memory of [0, -1, Number.NaN]) {
      expect(adviseStreamPressure({ cap: 20, machineMemoryBytes: memory }).level).toBe('ok');
    }
  });

  it('states its threshold as a judgement, not as a measurement', () => {
    // A quarter is not derived from anything, and the module says so beside the
    // constant. Asserted because the honest label is the difference between a
    // judgement and arithmetic dressed up as one.
    expect(WARN_AT_MACHINE_MEMORY_SHARE).toBe(0.25);
    const source = readFileSync(
      resolve(__dirname, '../../../src/contracts/stream-pressure-advice.ts'),
      'utf8'
    );
    expect(source).toMatch(/it is a judgement, and it is stated as/);
  });
});
