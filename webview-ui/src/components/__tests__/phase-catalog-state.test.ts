/**
 * The Builder's Phase save seam: what an author declared has to reach the write.
 *
 * WHY THIS EXISTS. `toSavePhaseRow` built the save body from an explicit
 * eleven-field list while the host's `AUTHORED_PHASE_FIELDS` declared twenty-one.
 * The eight it did not name were not refused — they were dropped, silently, on a
 * successful save. `sideEffects` is the one that matters most: it resolves to
 * `'workspace'` when omitted, so editing and saving a Phase that declared
 * `sideEffects: 'git'` handed the store a Phase that no longer writes Git
 * metadata, and the operator was told the save succeeded.
 *
 * This is the same shape of defect as the authoring -> invocation seam that
 * `tests/lint/phase-field-forwarding-seam.test.ts` closes host-side: two halves
 * each correct, and nothing carrying one into the other. That gate watches
 * definition -> adapter. This one watches editor -> save body, which had no gate
 * at all.
 *
 * Coverage is DERIVED from `AUTHORED_PHASE_FIELDS`, so the next authored field is
 * covered here with no edit to this file.
 */

import { describe, expect, it } from 'vitest';
import { AUTHORED_PHASE_FIELDS } from '../../../../src/contracts/process-definitions.js';
import {
  authoredPhaseDocument,
  sourceRecordToMutable,
  toSavePhaseRow
} from '../PipelineBuilderEditors/phase-catalog-state';
import type { MutablePhase } from '../PipelineBuilderEditors/types';

/**
 * A distinctive non-default value per authored field.
 *
 * Non-default on purpose: a field dropped on the way out shows up as absent or
 * changed rather than as coincidentally correct. `sideEffects: 'git'` in
 * particular cannot be confused with the resolver's `'workspace'` default.
 *
 * `phaseId` is absent because the Builder row is `id`-keyed; see the exclusion
 * test below, which pins that as a decision rather than an omission.
 */
const AUTHORED: Readonly<Record<string, unknown>> = {
  id: 'custom-phase',
  name: 'Custom',
  description: 'A described phase.',
  version: 3,
  instruction: 'Run the thing.',
  model: 'claude-opus-4-7',
  effort: 'high',
  timeoutSeconds: 45,
  spendBoundUsd: 5.5,
  spendBoundTokens: 100_000,
  loopable: true,
  retryCondition: 'attempts < 2',
  isRequired: false,
  forceContinueOnRetryCap: true,
  runner: 'codex',
  sideEffects: 'git',
  evidencePolicy: 'best-effort',
  hostVerification: 'exit-code',
  capabilities: ['workspace-write']
};

function rowWithEveryAuthoredField(): MutablePhase {
  return {
    ...AUTHORED,
    sourceKey: 'custom-phase::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    modelAvailable: true,
    persisted: true
  } as unknown as MutablePhase;
}

describe('toSavePhaseRow — the editor -> save-body seam', () => {
  it('covers every authored field the Builder row can carry', () => {
    // Derived, not listed. Two exclusions, each with a reason:
    //   `phaseId` — the row carries identity as `id`, and sending both spellings
    //     is what the host refuses as `identity-ambiguous`.
    //   `skill` — exclusive-or with `instruction`, so it cannot sit on the same
    //     fixture; the skill row below drives it.
    const drivenElsewhere = ['phaseId', 'skill'];
    const uncovered = [...AUTHORED_PHASE_FIELDS].filter(
      (field) => !drivenElsewhere.includes(field) && !(field in AUTHORED)
    );
    expect(
      uncovered,
      `authored fields this test does not drive: ${uncovered.join(', ')}. ` +
        'Add each to AUTHORED with a distinctive non-default value.'
    ).toEqual([]);
  });

  it('forwards a skill directive, which cannot share a row with instruction', () => {
    const skillRow = {
      id: 'reviewed', name: 'Reviewed', version: 1, skill: 'security-review',
      sourceKey: 'reviewed::0', sourceStatus: 'effective', sourceErrors: [], persisted: true
    } as unknown as MutablePhase;
    const body = toSavePhaseRow(skillRow) as unknown as Record<string, unknown>;
    expect(body.skill).toBe('security-review');
    expect('instruction' in body).toBe(false);
  });

  it.each(Object.entries(AUTHORED))('forwards an authored %s to the save body', (field, value) => {
    const body = toSavePhaseRow(rowWithEveryAuthoredField()) as unknown as Record<string, unknown>;
    expect(
      body[field],
      `${field} was authored on the row and did not reach the save body`
    ).toEqual(value);
  });

  it('sends no projection-only field to the host', () => {
    // The complement of the rule above, and the reason the body is built from an
    // allowlist rather than by deleting known view fields: a denylist silently
    // forwards whatever it has not heard of.
    const body = toSavePhaseRow(rowWithEveryAuthoredField()) as unknown as Record<string, unknown>;
    for (const field of ['sourceKey', 'sourceStatus', 'sourceErrors', 'modelAvailable', 'persisted']) {
      expect(field in body, `${field} is projection-only and must not be sent`).toBe(false);
    }
    expect([...Object.keys(body)].filter((field) => !AUTHORED_PHASE_FIELDS.has(field))).toEqual([]);
  });

  it('omits an absent optional field rather than sending undefined', () => {
    const minimal = {
      id: 'minimal', name: 'Minimal', version: 1, instruction: 'Go.',
      sourceKey: 'minimal::0', sourceStatus: 'effective', sourceErrors: [], persisted: true
    } as unknown as MutablePhase;
    const body = toSavePhaseRow(minimal) as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['id', 'instruction', 'name', 'version']);
  });

  it('carries a narrowed capability set from the projected record through to the save body', () => {
    // The field `display` cannot carry. `recognizedDisplay` admits
    // `string | number | boolean | null`, and `capabilities` is the sole
    // array-valued authored field — so it arrives on the definition or not at all,
    // and "not at all" meant a narrowed authority widening back to every
    // capability on an unrelated edit, because omission means the default set.
    const row = sourceRecordToMutable({
      key: 'narrowed::0',
      phaseId: 'narrowed',
      status: 'effective',
      definition: {
        phaseId: 'narrowed',
        name: 'Narrowed',
        version: 1,
        instruction: 'Read only.',
        capabilities: ['workspace-write']
      },
      display: { name: 'Narrowed', version: 1 },
      errors: []
    } as never);
    expect(row.capabilities, 'the editor row never received the declared authority').toEqual([
      'workspace-write'
    ]);
    const body = toSavePhaseRow(row) as unknown as Record<string, unknown>;
    expect(
      body.capabilities,
      'a narrowed phase must not be saved back with every capability'
    ).toEqual(['workspace-write']);
  });

  it('carries a declared sideEffects from the projected record through to the save body', () => {
    // The whole round trip the operator actually performs: the host projects a
    // Phase that declares `git`, the editor holds it, the save body goes back.
    // `sideEffects` reaches the webview on `display` — `recognizedDisplay`
    // copies it because it is authored — so a row can hold it even though
    // `PortablePhaseDefinition` does not yet name it.
    const row = sourceRecordToMutable({
      key: 'finalize::0',
      phaseId: 'finalize',
      status: 'effective',
      definition: {
        phaseId: 'finalize', name: 'Finalize', version: 2, instruction: 'Commit.'
      },
      display: { sideEffects: 'git', evidencePolicy: 'none' },
      errors: []
    } as never);
    expect(row.sideEffects).toBe('git');
    const body = toSavePhaseRow(row) as unknown as Record<string, unknown>;
    expect(body.sideEffects, 'a git phase must not be saved back as a workspace phase').toBe('git');
    expect(body.evidencePolicy).toBe('none');
  });
});

describe('the raw JSON document the editor hands to the operator', () => {
  /**
   * The reported bug, in one sentence: the JSON view refused the document it had
   * itself just serialized.
   *
   * `PhaseCatalogEditor` built that document with a DENYLIST — a destructure
   * stripping the five projection fields it knew about and forwarding the rest —
   * while `RawJsonPhaseEditor` validates against `AUTHORED_PHASE_FIELDS`, an
   * allowlist. `MutablePhase` carries `[key: string]: unknown`, so anything can ride
   * on a row, and the two disagree the moment one field is added that the destructure
   * does not name. Save is then dead and no edit clears it, because the offending key
   * is not one the operator typed.
   */
  const ROW: MutablePhase = {
    id: 'finalize',
    name: 'Finalize',
    version: 2,
    instruction: 'Commit.',
    sideEffects: 'git',
    capabilities: ['workspace-write'],
    sourceKey: 'finalize::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    modelAvailable: true,
    persisted: true
  } as MutablePhase;

  it('holds only names the raw JSON editor accepts', () => {
    // The invariant that closes the whole class, derived rather than listed: this
    // holds for a field added tomorrow, which is exactly when the denylist broke.
    const document = authoredPhaseDocument(ROW);
    const refused = Object.keys(document).filter(
      (field) => !AUTHORED_PHASE_FIELDS.has(field) || field === 'phaseId'
    );
    expect(refused, 'these keys make Save unreachable and no edit can clear them').toEqual([]);
  });

  it('omits a projection field it has never heard of', () => {
    // A row field of the shape feature 186 is adding right now. A denylist forwards
    // precisely the fields nobody thought to strip.
    const document = authoredPhaseDocument({
      ...ROW,
      detailTier: 'row',
      lifecycle: { status: 'active' }
    } as MutablePhase);
    expect('detailTier' in document).toBe(false);
    expect('lifecycle' in document).toBe(false);
  });

  it('carries every authored declaration the row holds', () => {
    const document = authoredPhaseDocument(ROW);
    expect(document).toEqual({
      id: 'finalize',
      name: 'Finalize',
      version: 2,
      instruction: 'Commit.',
      sideEffects: 'git',
      capabilities: ['workspace-write']
    });
  });

  it('spells identity as `id` and never as `phaseId`', () => {
    // The host refuses a document carrying both as `identity-ambiguous`, and the
    // raw-JSON editor declines the name for the same reason.
    const document = authoredPhaseDocument({ ...ROW, phaseId: 'finalize' } as MutablePhase);
    expect(document.id).toBe('finalize');
    expect('phaseId' in document).toBe(false);
  });

  it('omits the empty spelling of inherit that an invalid row carries', () => {
    // HOW A ROW GETS HERE, since `MutablePhase['effort']` cannot express `''` and the
    // two selects both convert their empty option to `undefined`: the host refuses an
    // empty `model` or `effort`, so such a row has no definition, so `display` is all
    // it has — and `display` carries the empty string, which
    // `sourceRecordToMutable` spreads onto the row through its index signature.
    //
    // Serializing that produces a document the raw-JSON editor refuses, with no edit
    // that clears the error: the reported symptom exactly, in a second pair of fields.
    // Hence the cast through `unknown` — the value is reachable at runtime and
    // untypeable at the boundary it arrives through.
    const row = { ...ROW, model: '', effort: '' } as unknown as MutablePhase;
    const document = authoredPhaseDocument(row);
    expect('model' in document).toBe(false);
    expect('effort' in document).toBe(false);
  });

  it('agrees with the save body about what is authored', () => {
    // Two projections of one row. They disagreed on ten fields once; the document
    // and the body are now the same walk over the same set.
    const document = authoredPhaseDocument(ROW);
    const body = toSavePhaseRow(ROW) as unknown as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual(Object.keys(body).sort());
  });
});
