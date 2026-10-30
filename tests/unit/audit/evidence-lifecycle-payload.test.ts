// Feature 251 (FR-R4-F04, contract T13, FR-020; E1, E2) — the closed `evidence-exported` payload.
//
// What it pins: `projectEvidenceExported` accepts each valid `ExportOutcome` of the three kinds and both
// outcomes, and returns exactly the keys of that outcome; and it throws `AuditPayloadValidationError` with
// `malformed-evidence-exported` on an extra key (nothing a caller adds can reach the log), a path-shaped
// string where an enum belongs, a negative or fractional count, a `refusal` on an `exported` row, and a
// missing `refusal` on a `refused` one. The audit writer routes the event type through it, so a row that
// reaches disk is one of the shapes below and nothing else.
//
// Why: an export row sits in the shared audit log beside every other Run's. If the projector were open, a
// destination path, a file name or an operator identity could ride in on any key; the closed shape is
// what makes "the row carries no path" a property of the type and not of every caller's care.

import { describe, expect, it } from 'vitest';

import { AuditPayloadValidationError, projectAuditPayload } from '../../../src/audit/audit-payload';
import { projectEvidenceExported } from '../../../src/audit/evidence-lifecycle-payload';
import {
  EXPORT_KINDS,
  EXPORT_REFUSALS,
  exportOutcomePayload,
  type ExportOutcome
} from '../../../src/contracts/evidence-export-outcome';

const REASON = 'malformed-evidence-exported';

const exported = (kind: ExportOutcome['kind']): ExportOutcome => ({ kind, outcome: 'exported', included: 3, omitted: 1 });
const refused = (refusal: (typeof EXPORT_REFUSALS)[number]): ExportOutcome => ({
  kind: 'run-evidence',
  outcome: 'refused',
  included: 0,
  omitted: 0,
  refusal
});

function rejects(payload: Record<string, unknown>): void {
  let thrown: unknown;
  try {
    projectEvidenceExported(payload);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, JSON.stringify(payload)).toBeInstanceOf(AuditPayloadValidationError);
  expect((thrown as AuditPayloadValidationError).reasonCode).toBe(REASON);
}

describe('projectEvidenceExported accepts every valid outcome (T13)', () => {
  it.each(EXPORT_KINDS)('an exported %s row', (kind) => {
    const payload = exportOutcomePayload(exported(kind));
    expect(projectEvidenceExported({ ...payload })).toEqual(payload);
    expect(Object.keys(payload).sort()).toEqual(['included', 'kind', 'omitted', 'outcome']);
  });

  it.each(EXPORT_REFUSALS)('a refused row with %s', (refusal) => {
    const payload = exportOutcomePayload(refused(refusal));
    expect(projectEvidenceExported({ ...payload })).toEqual(payload);
    expect(payload).toMatchObject({ outcome: 'refused', refusal, included: 0 });
  });

  it('is the projection the audit writer applies to the event type', () => {
    const payload = exportOutcomePayload(exported('audit-metadata'));
    expect(projectAuditPayload('evidence-exported', { ...payload })).toEqual(payload);
    expect(() => projectAuditPayload('evidence-exported', { ...payload, destination: '/tmp/out' })).toThrow(
      AuditPayloadValidationError
    );
  });
});

describe('projectEvidenceExported rejects everything else (T13)', () => {
  const valid = { ...exportOutcomePayload(exported('run-evidence')) };

  it('an extra key, whatever its value', () => {
    rejects({ ...valid, destination: 'archive.zip' });
    rejects({ ...valid, actor: 'someone' });
    rejects({ ...valid, runId: 'abc' });
  });

  it('a path-shaped or unknown string where an enum belongs', () => {
    rejects({ ...valid, kind: '/Users/someone/exports' });
    rejects({ ...valid, kind: 'run-evidence-extra' });
    rejects({ ...valid, outcome: 'done' });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined])('a count of %s', (count) => {
    rejects({ ...valid, included: count });
    rejects({ ...valid, omitted: count });
  });

  it('a refusal on an exported row', () => {
    rejects({ ...valid, refusal: 'write-failed' });
  });

  it('a missing or unknown refusal on a refused row', () => {
    const base = { ...exportOutcomePayload(refused('no-evidence')) } as Record<string, unknown>;
    delete base.refusal;
    rejects(base);
    rejects({ ...base, refusal: 'C:\\temp\\out' });
  });

  it('a refused row that claims included items', () => {
    rejects({ ...exportOutcomePayload(refused('write-failed')), included: 2 });
  });

  it('a missing key', () => {
    const { included: _included, ...rest } = valid;
    void _included;
    rejects(rest);
  });
});
