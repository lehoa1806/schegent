// `display` is what an INVALID row shows the operator — and it could not carry a list.
//
// WHY THIS EXISTS. Each of the three catalog validators builds a `display` map for
// a row that failed validation, so the Builder has something to show when there is
// no parsed definition to read. All three admitted
// `string | number | boolean | null` and silently dropped everything else. Every
// authored set contains fields that are lists:
//
//   phase     capabilities
//   pipeline  phases, phaseIds, inputs, outputs, bindings, recommendedNext
//   workflow  nodes, connections, startNodeIds
//
// THREE SITES WERE WRITTEN EXPECTING OTHERWISE, and all three were dead:
//
//   1. `definition-semantics.ts` `authoredPhaseIds()` reads `display['phases']` to
//      decide whether an invalid Pipeline still blocks deleting a Phase. Its own
//      comment gives the reason — "its defects are corrected and the reference goes
//      live, and a Phase deleted out from under it in the meantime would leave it
//      permanently unfixable" — and its `Array.isArray` guard could never be true,
//      so an invalid Pipeline blocked nothing.
//   2. `pipeline-catalog-state.ts` `sourceRecordToMutablePipeline()` reads the same
//      key to repopulate an invalid Pipeline's phase list, under a comment saying
//      "falling back to an empty row would silently discard what they typed". It
//      fell back to an empty row.
//   3. A Phase's `capabilities` never reached the Builder by this route either,
//      which is how repairing an invalid Phase widened its authority back to every
//      capability.
//
// SCALAR LISTS ONLY, and the bound is deliberate. `inputs`, `outputs`, `bindings`,
// `nodes` and `connections` are lists of objects and `executionDefaults` is an
// object; admitting those means sanitising to unbounded depth on the one path whose
// input is by definition malformed. No site reads them from `display`, so nothing
// is closed by admitting them. If one ever does, this is the file that has to say
// so first.
import { describe, expect, it } from 'vitest';

import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';
import { validatePipelineDefinition } from '../../../src/config/pipeline-definition-validator';
import { validateWorkflowDefinition } from '../../../src/config/workflow-definition-validator';

/** An empty name fails `invalid-length` in all three, leaving the rest of the row intact. */
const BREAKS_THE_ROW = { name: '' };

interface Validated {
  readonly errors?: readonly unknown[];
  readonly display?: Readonly<Record<string, unknown>>;
}

const CASES = [
  {
    kind: 'phase',
    field: 'capabilities',
    value: ['workspace-write'],
    validate: (raw: unknown): Validated =>
      validatePhaseDefinition(raw) as unknown as Validated,
    row: { phaseId: 'p', version: 1, instruction: 'Go.' }
  },
  {
    kind: 'pipeline',
    field: 'phases',
    value: ['plan', 'build'],
    validate: (raw: unknown): Validated =>
      validatePipelineDefinition(raw) as unknown as Validated,
    row: { pipelineId: 'pl', version: 1 }
  },
  {
    kind: 'workflow',
    field: 'startNodeIds',
    value: ['n1'],
    validate: (raw: unknown): Validated =>
      validateWorkflowDefinition(raw) as unknown as Validated,
    row: { workflowId: 'wf', version: 1, nodes: [], connections: [] }
  }
] as const;

describe('an invalid row keeps its authored lists on `display`', () => {
  it.each(CASES)('$kind carries $field', ({ field, value, validate, row }) => {
    const result = validate({ ...row, ...BREAKS_THE_ROW, [field]: value });
    // The control: this must be an INVALID row, or `display` is not the path under
    // test — a valid row is read from its definition instead.
    expect(result.errors?.length, 'the fixture must fail validation').toBeGreaterThan(0);
    expect(
      result.display?.[field],
      `${field} is an authored field and the operator typed it; dropping it from ` +
        '`display` is how an invalid row loses a declaration on repair'
    ).toEqual(value);
  });

  it.each(CASES)('$kind keeps a scalar list frozen against mutation', ({ field, value, validate, row }) => {
    const result = validate({ ...row, ...BREAKS_THE_ROW, [field]: value });
    const carried = result.display?.[field];
    // Asserted to BE a list first: `Object.isFrozen(undefined)` is `true`, so a
    // dropped field would satisfy the freeze check vacuously.
    expect(Array.isArray(carried), `${field} did not reach display as a list`).toBe(true);
    expect(Object.isFrozen(carried), '`display` is projected state and never a live handle').toBe(
      true
    );
  });

  it.each(CASES)('$kind drops a non-scalar element rather than the whole list', ({ field, validate, row }) => {
    // A malformed row is the only input this path ever sees, so a list holding an
    // object must not cost the operator the entries beside it.
    const result = validate({
      ...row,
      ...BREAKS_THE_ROW,
      [field]: ['keep-me', { nested: 'object' }, ['nested-list'], 'keep-me-too']
    });
    expect(result.display?.[field]).toEqual(['keep-me', 'keep-me-too']);
  });

  it.each(CASES)('$kind admits no list of objects, which nothing reads', ({ validate, row }) => {
    // Pinned as a decision, not left as an accident: see the header. `inputs` is a
    // Pipeline field, so this only asserts the shared predicate's posture.
    //
    // ABSENT, not `[]`. A list that loses every entry is not an empty list, and
    // reporting an authored `inputs` of one port as a declaration of none would be
    // a worse answer than declining to answer.
    const result = validate({
      ...row,
      ...BREAKS_THE_ROW,
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }]
    });
    expect('inputs' in (result.display ?? {})).toBe(false);
  });

  it.each(CASES)('$kind carries an authored empty list as empty', ({ field, validate, row }) => {
    // The other side of the rule above: `[]` the operator actually wrote is a
    // declaration, and it has to survive as one.
    const result = validate({ ...row, ...BREAKS_THE_ROW, [field]: [] });
    expect(result.display?.[field], `an authored empty ${field} is a declaration`).toEqual([]);
  });
});
