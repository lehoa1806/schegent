// FR-R6-F15 T030 — a review report and a fix-claim set, parsed from text: what is accepted,
// each bound of NFR-006 at its limit and one over, and every fault refusing the whole artifact.
import { describe, expect, it } from 'vitest';

import { PHASE_CONTEXT_LIMITS } from '../../../src/contracts/phase-context/context-policy';
import type { NewFinding } from '../../../src/contracts/phase-context/review-loop';
import { parseFixClaims, parseReviewReport } from '../../../src/services/phase-context/review-report';
import {
  finding,
  fixClaims,
  fixClaimsText,
  marker,
  reviewReport,
  reviewReportText,
  textOfBytes,
  wideTextOfBytes
} from '../../fixtures/phase-context/builders';

const ARTIFACT_BYTES_MAX = 262_144;
const RECORD_BYTES_MAX = 2_048;

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function findings(count: number): NewFinding[] {
  return Array.from({ length: count }, (_unused, index) => finding({ id: `F-${String(index + 1)}` }));
}

function dispositions(count: number): { findingId: string; status: 'open' }[] {
  return Array.from({ length: count }, (_unused, index) => ({ findingId: `P-${String(index + 1)}`, status: 'open' }));
}

function claims(count: number): { findingId: string; claim: 'claimed-fixed' }[] {
  return Array.from({ length: count }, (_unused, index) => ({ findingId: `F-${String(index + 1)}`, claim: 'claimed-fixed' }));
}

/** A finding whose record is exactly `bytes` long as JSON. */
function findingOfRecordBytes(bytes: number): NewFinding {
  const base = finding({ title: textOfBytes(512), explanation: textOfBytes(1024), evidence: ['a', 'b'] });
  const spare = bytes - JSON.stringify(base).length;
  const first = Math.min(spare, 255);
  return { ...base, evidence: ['a'.repeat(1 + first), 'b'.repeat(1 + spare - first)] };
}

function reportWith(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...reviewReport(), ...fields });
}

function reportWithFinding(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...reviewReport(), findings: [{ ...finding(), ...fields }] });
}

function reportWithDisposition(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...reviewReport(), findings: [], dispositions: [{ findingId: 'F-1', status: 'open', ...fields }] });
}

function claimsWith(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...fixClaims(), ...fields });
}

function claimsWithClaim(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...fixClaims(), claims: [{ findingId: 'F-1', claim: 'claimed-fixed', ...fields }] });
}

function without(record: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

describe('parseReviewReport', () => {
  it('parses a valid report to the report it states', () => {
    expect(parseReviewReport(reviewReportText())).toEqual({ ok: true, report: reviewReport() });
  });

  it('parses findings and dispositions together', () => {
    const report = reviewReport({
      pass: 2,
      previousReportRef: 'report@1',
      coverage: 'partial',
      reviewPassed: false,
      blockingCount: 2,
      findings: [finding({ id: 'F-2', severity: 'critical', explanation: '', evidence: [] }), finding({ id: 'F-3', severity: 'info' })],
      dispositions: [
        { findingId: 'F-1', status: 'resolved' },
        { findingId: 'F-0', status: 'reopened' },
        { findingId: 'F-00', status: 'unresolved' },
        { findingId: 'F-000', status: 'open' }
      ]
    });

    expect(parseReviewReport(JSON.stringify(report))).toEqual({ ok: true, report });
  });

  it('parses a report with no finding and no disposition', () => {
    const report = reviewReport({ reviewPassed: true, blockingCount: 0, findings: [], dispositions: [] });

    expect(parseReviewReport(JSON.stringify(report))).toEqual({ ok: true, report });
  });

  it('reads the keys in any order and writes them in one', () => {
    const reversed = Object.fromEntries(Object.entries(reviewReport()).reverse());

    const result = parseReviewReport(JSON.stringify(reversed));

    expect(result).toEqual({ ok: true, report: reviewReport() });
    expect(JSON.stringify(result)).toBe(JSON.stringify({ ok: true, report: reviewReport() }));
  });

  it('gives equal results for equal input', () => {
    expect(parseReviewReport(reviewReportText())).toEqual(parseReviewReport(reviewReportText()));
    expect(parseReviewReport('{')).toEqual(parseReviewReport('{'));
  });

  describe('version', () => {
    it('refuses a newer version as unsupported, whatever else it holds', () => {
      expect(parseReviewReport(reportWith({ reportVersion: 2 }))).toEqual(refusal('unsupported-version', 'report-version'));
      expect(parseReviewReport(JSON.stringify({ reportVersion: 3, body: 'of another shape' }))).toEqual(
        refusal('unsupported-version', 'report-version')
      );
    });

    it.each([
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction', 1.5],
      ['text', '1'],
      ['null', null]
    ])('refuses a version that is %s', (_label, reportVersion) => {
      expect(parseReviewReport(reportWith({ reportVersion }))).toEqual(refusal('invalid-source', 'report-version'));
    });

    it('refuses a report with no version', () => {
      expect(parseReviewReport(JSON.stringify(without(reviewReport(), 'reportVersion')))).toEqual(
        refusal('invalid-source', 'report-version')
      );
    });
  });

  describe('the artifact', () => {
    it('accepts a text of exactly 256 KiB and refuses one byte more', () => {
      const text = reviewReportText();
      const atLimit = text + ' '.repeat(ARTIFACT_BYTES_MAX - text.length);

      expect(parseReviewReport(atLimit)).toEqual({ ok: true, report: reviewReport() });
      expect(parseReviewReport(`${atLimit} `)).toEqual(refusal('invalid-source', 'artifact-oversized'));
    });

    it.each([
      ['a value at depth 17', '['.repeat(17) + ']'.repeat(17), 'artifact-too-deep'],
      ['8,193 values', `[${Array.from({ length: 8_192 }, () => '0').join(',')}]`, 'artifact-too-many-values'],
      ['a duplicate key', reviewReportText().replace('{', '{"pass":1,'), 'artifact-duplicate-key'],
      ['a duplicate key in a finding', reviewReportText().replace('"severity"', '"id":"F-1","severity"'), 'artifact-duplicate-key'],
      ['a key named __proto__', reviewReportText().replace('{', '{"__proto__":{},'), 'artifact-forbidden-key'],
      ['a key named constructor in a finding', reviewReportText().replace('"severity"', '"constructor":1,"severity"'), 'artifact-forbidden-key'],
      ['a key named prototype', reviewReportText().replace('{', '{"prototype":1,'), 'artifact-forbidden-key'],
      ['text that is not JSON', 'review passed', 'artifact-malformed'],
      ['a cut text', reviewReportText().slice(0, -1), 'artifact-malformed'],
      ['trailing text', `${reviewReportText()} done`, 'artifact-malformed'],
      ['an empty text', '', 'artifact-malformed']
    ])('refuses %s', (_label, text, detail) => {
      expect(parseReviewReport(text)).toEqual(refusal('invalid-source', detail));
    });

    it('refuses a value that is not text', () => {
      expect(parseReviewReport(reviewReport() as unknown as string)).toEqual(refusal('invalid-source', 'artifact-malformed'));
    });

    it.each([
      ['a list', '[]'],
      ['null', 'null'],
      ['a number', '1'],
      ['text', '"report"']
    ])('refuses %s in place of the report', (_label, text) => {
      expect(parseReviewReport(text)).toEqual(refusal('invalid-source', 'report-shape'));
    });
  });

  describe('the report', () => {
    it('refuses a key the contract does not name', () => {
      expect(parseReviewReport(reportWith({ note: 'extra' }))).toEqual(refusal('invalid-source', 'report-shape'));
    });

    it.each([
      'loopId',
      'pass',
      'reviewerAttemptId',
      'candidateRef',
      'scopeRevision',
      'criteriaRevision',
      'previousReportRef',
      'coverage',
      'reviewPassed',
      'blockingCount',
      'findings',
      'dispositions'
    ])('refuses a report without %s', (key) => {
      expect(parseReviewReport(JSON.stringify(without(reviewReport(), key)))).toEqual(refusal('invalid-source', 'report-shape'));
    });

    it.each([
      ['an empty loop identity', { loopId: '' }],
      ['a loop identity with a space', { loopId: 'loop 1' }],
      ['a loop identity of 129 characters', { loopId: textOfBytes(129) }],
      ['a loop identity that is a number', { loopId: 1 }],
      ['pass zero', { pass: 0 }],
      ['a pass that is a fraction', { pass: 1.5 }],
      ['a pass that is text', { pass: '1' }],
      ['a reviewer attempt with a slash', { reviewerAttemptId: 'att/1' }],
      ['a candidate with a space', { candidateRef: 'candidate 1' }],
      ['a candidate of 257 characters', { candidateRef: textOfBytes(257) }],
      ['an empty scope revision', { scopeRevision: '' }],
      ['a criteria revision that is null', { criteriaRevision: null }],
      ['a previous report that is a number', { previousReportRef: 1 }],
      ['an empty previous report', { previousReportRef: '' }],
      ['a coverage the contract does not name', { coverage: 'full' }],
      ['a coverage that is a flag', { coverage: true }],
      ['a verdict that is text', { reviewPassed: 'false' }],
      ['a verdict that is null', { reviewPassed: null }],
      ['a negative blocking count', { blockingCount: -1 }],
      ['a blocking count that is a fraction', { blockingCount: 0.5 }],
      ['findings that are not a list', { findings: { 0: finding() } }],
      ['dispositions that are not a list', { dispositions: null }]
    ])('refuses %s', (_label, fields) => {
      expect(parseReviewReport(reportWith(fields))).toEqual(refusal('invalid-source', 'report-field'));
    });

    it('accepts the longest permitted identities and references', () => {
      const report = reviewReport({
        loopId: textOfBytes(128),
        reviewerAttemptId: textOfBytes(128),
        candidateRef: textOfBytes(256),
        scopeRevision: textOfBytes(256),
        criteriaRevision: textOfBytes(256),
        pass: 2,
        previousReportRef: textOfBytes(256)
      });

      expect(parseReviewReport(JSON.stringify(report))).toEqual({ ok: true, report });
    });
  });

  describe('the record count', () => {
    it('accepts 200 findings and refuses 201', () => {
      expect(parseReviewReport(reviewReportText({ findings: findings(200) })).ok).toBe(true);
      expect(parseReviewReport(reviewReportText({ findings: findings(201) }))).toEqual(refusal('invalid-source', 'record-count'));
    });

    it('accepts 200 dispositions and refuses 201', () => {
      expect(parseReviewReport(reviewReportText({ findings: [], dispositions: dispositions(200) })).ok).toBe(true);
      expect(parseReviewReport(reviewReportText({ findings: [], dispositions: dispositions(201) }))).toEqual(
        refusal('invalid-source', 'record-count')
      );
    });

    it('counts findings and dispositions together', () => {
      expect(parseReviewReport(reviewReportText({ findings: findings(100), dispositions: dispositions(100) })).ok).toBe(true);
      expect(parseReviewReport(reviewReportText({ findings: findings(100), dispositions: dispositions(101) }))).toEqual(
        refusal('invalid-source', 'record-count')
      );
    });
  });

  describe('a finding', () => {
    it('refuses a finding that is not a record, has a key too many or a key too few', () => {
      expect(parseReviewReport(reportWith({ findings: ['F-1'] }))).toEqual(refusal('invalid-source', 'finding-shape'));
      expect(parseReviewReport(reportWithFinding({ note: 'extra' }))).toEqual(refusal('invalid-source', 'finding-shape'));
      expect(parseReviewReport(reportWith({ findings: [without(finding(), 'evidence')] }))).toEqual(
        refusal('invalid-source', 'finding-shape')
      );
    });

    it.each([
      ['an empty identity', ''],
      ['an identity with a space', 'F 1'],
      ['an identity that starts with a dash', '-F1'],
      ['an identity with a colon', 'F:1'],
      ['an identity of 65 characters', textOfBytes(65)],
      ['an identity that is a number', 1]
    ])('refuses %s', (_label, id) => {
      expect(parseReviewReport(reportWithFinding({ id }))).toEqual(refusal('invalid-source', 'finding-id'));
    });

    it('accepts an identity of 64 characters', () => {
      expect(parseReviewReport(reportWithFinding({ id: textOfBytes(64) })).ok).toBe(true);
    });

    it.each([
      ['a severity the contract does not name', 'blocker'],
      ['a severity in another case', 'High'],
      ['a severity that is a number', 1]
    ])('refuses %s', (_label, severity) => {
      expect(parseReviewReport(reportWithFinding({ severity }))).toEqual(refusal('invalid-source', 'finding-severity'));
    });

    it.each(['critical', 'high', 'medium', 'low', 'info'])('accepts the severity %s', (severity) => {
      expect(parseReviewReport(reportWithFinding({ severity })).ok).toBe(true);
    });

    it('accepts a title of 512 bytes and refuses 513', () => {
      expect(parseReviewReport(reportWithFinding({ title: textOfBytes(512) })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ title: textOfBytes(513) }))).toEqual(refusal('invalid-source', 'finding-title'));
    });

    it('measures a title in bytes', () => {
      expect(parseReviewReport(reportWithFinding({ title: wideTextOfBytes(512) })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ title: wideTextOfBytes(514) }))).toEqual(
        refusal('invalid-source', 'finding-title')
      );
    });

    it.each([
      ['an empty title', ''],
      ['a title with a control character', `a${String.fromCharCode(7)}b`],
      ['a title with a lone surrogate', `a${String.fromCharCode(0xd800)}b`],
      ['a title that is a list', ['a']]
    ])('refuses %s', (_label, title) => {
      expect(parseReviewReport(reportWithFinding({ title }))).toEqual(refusal('invalid-source', 'finding-title'));
    });

    it('accepts an empty explanation, one of 1 KiB, and refuses one byte more', () => {
      expect(parseReviewReport(reportWithFinding({ explanation: '' })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ explanation: textOfBytes(1024) })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ explanation: textOfBytes(1025) }))).toEqual(
        refusal('invalid-source', 'finding-explanation')
      );
    });

    it.each([
      ['an explanation with a control character', `a${String.fromCharCode(27)}b`],
      ['an explanation that is null', null]
    ])('refuses %s', (_label, explanation) => {
      expect(parseReviewReport(reportWithFinding({ explanation }))).toEqual(refusal('invalid-source', 'finding-explanation'));
    });

    it('accepts no evidence and eight references, and refuses nine', () => {
      const references = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `report#L${String(index)}`);

      expect(parseReviewReport(reportWithFinding({ evidence: [] })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ evidence: references(8) })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ evidence: references(9) }))).toEqual(refusal('invalid-source', 'finding-evidence'));
    });

    it('accepts a reference of 256 bytes and refuses 257', () => {
      const limit = PHASE_CONTEXT_LIMITS.evidenceReferenceBytesMax;

      expect(limit).toBe(256);
      expect(parseReviewReport(reportWithFinding({ evidence: [textOfBytes(limit)] })).ok).toBe(true);
      expect(parseReviewReport(reportWithFinding({ evidence: [textOfBytes(limit + 1)] }))).toEqual(
        refusal('invalid-source', 'finding-evidence')
      );
    });

    it.each([
      ['evidence that is not a list', 'report#L10'],
      ['a reference with a space', ['report L10']],
      ['an empty reference', ['']],
      ['a reference that is a number', [10]]
    ])('refuses %s', (_label, evidence) => {
      expect(parseReviewReport(reportWithFinding({ evidence }))).toEqual(refusal('invalid-source', 'finding-evidence'));
    });

    it('accepts a record of exactly 2 KiB and refuses one byte more', () => {
      const atLimit = findingOfRecordBytes(RECORD_BYTES_MAX);
      const over = findingOfRecordBytes(RECORD_BYTES_MAX + 1);

      expect(JSON.stringify(atLimit)).toHaveLength(RECORD_BYTES_MAX);
      expect(JSON.stringify(over)).toHaveLength(RECORD_BYTES_MAX + 1);
      expect(parseReviewReport(reviewReportText({ findings: [atLimit] })).ok).toBe(true);
      expect(parseReviewReport(reviewReportText({ findings: [over] }))).toEqual(refusal('invalid-source', 'record-bytes'));
    });

    it('refuses two findings with one identity', () => {
      const twice = [finding(), finding({ id: 'F-2' }), finding({ severity: 'low' })];

      expect(parseReviewReport(reviewReportText({ findings: twice }))).toEqual(refusal('invalid-source', 'finding-duplicate'));
    });
  });

  describe('a disposition', () => {
    it('refuses a disposition that is not a record, has a key too many or a key too few', () => {
      expect(parseReviewReport(reportWith({ dispositions: [['F-1', 'open']] }))).toEqual(refusal('invalid-source', 'disposition-shape'));
      expect(parseReviewReport(reportWithDisposition({ note: 'extra' }))).toEqual(refusal('invalid-source', 'disposition-shape'));
      expect(parseReviewReport(reportWith({ dispositions: [{ findingId: 'F-1' }] }))).toEqual(
        refusal('invalid-source', 'disposition-shape')
      );
    });

    it('refuses a bad finding identity', () => {
      expect(parseReviewReport(reportWithDisposition({ findingId: 'F 1' }))).toEqual(refusal('invalid-source', 'finding-id'));
      expect(parseReviewReport(reportWithDisposition({ findingId: textOfBytes(65) }))).toEqual(refusal('invalid-source', 'finding-id'));
    });

    it.each([
      ['a status the contract does not name', 'closed'],
      ['a claim kind in place of a status', 'claimed-fixed'],
      ['a status that is a flag', true]
    ])('refuses %s', (_label, status) => {
      expect(parseReviewReport(reportWithDisposition({ status }))).toEqual(refusal('invalid-source', 'disposition-status'));
    });

    it.each(['open', 'resolved', 'reopened', 'unresolved'])('accepts the status %s', (status) => {
      expect(parseReviewReport(reportWithDisposition({ status })).ok).toBe(true);
    });

    it('refuses two dispositions for one finding', () => {
      const twice = [
        { findingId: 'F-1', status: 'open' },
        { findingId: 'F-2', status: 'open' },
        { findingId: 'F-1', status: 'resolved' }
      ];

      expect(parseReviewReport(reportWith({ findings: [], dispositions: twice }))).toEqual(
        refusal('invalid-source', 'disposition-duplicate')
      );
    });
  });

  it('refuses the whole report for one bad record among good ones', () => {
    const mixed = [...findings(5), { ...finding({ id: 'F-9' }), severity: 'blocker' }];

    expect(parseReviewReport(reportWith({ findings: mixed }))).toEqual(refusal('invalid-source', 'finding-severity'));
  });

  it('carries no text of a refused report in the refusal', () => {
    const seeded = marker('title');

    const result = parseReviewReport(reportWithFinding({ title: seeded, severity: 'blocker', explanation: marker('explanation') }));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SEEDED');
  });
});

describe('parseFixClaims', () => {
  it('parses a valid claim set to the claims it states', () => {
    expect(parseFixClaims(fixClaimsText())).toEqual({ ok: true, claims: fixClaims() });
  });

  it('parses every kind of claim', () => {
    const set = fixClaims({
      pass: 3,
      basedOnReportRef: 'report@3',
      claims: [
        { findingId: 'F-1', claim: 'claimed-fixed' },
        { findingId: 'F-2', claim: 'not-addressed' },
        { findingId: 'F-3', claim: 'disputed' }
      ]
    });

    expect(parseFixClaims(JSON.stringify(set))).toEqual({ ok: true, claims: set });
  });

  it('parses a set with no claim', () => {
    expect(parseFixClaims(fixClaimsText({ claims: [] }))).toEqual({ ok: true, claims: fixClaims({ claims: [] }) });
  });

  it('refuses a newer version as unsupported', () => {
    expect(parseFixClaims(claimsWith({ claimsVersion: 2 }))).toEqual(refusal('unsupported-version', 'claims-version'));
  });

  it.each([
    ['zero', 0],
    ['a fraction', 1.5],
    ['text', '1']
  ])('refuses a version that is %s', (_label, claimsVersion) => {
    expect(parseFixClaims(claimsWith({ claimsVersion }))).toEqual(refusal('invalid-source', 'claims-version'));
  });

  it('refuses a set with no version, and a value that is not a record', () => {
    expect(parseFixClaims(JSON.stringify(without(fixClaims(), 'claimsVersion')))).toEqual(refusal('invalid-source', 'claims-version'));
    expect(parseFixClaims('[]')).toEqual(refusal('invalid-source', 'claims-shape'));
  });

  it('accepts a text of exactly 256 KiB and refuses one byte more', () => {
    const text = fixClaimsText();
    const atLimit = text + ' '.repeat(ARTIFACT_BYTES_MAX - text.length);

    expect(parseFixClaims(atLimit)).toEqual({ ok: true, claims: fixClaims() });
    expect(parseFixClaims(`${atLimit} `)).toEqual(refusal('invalid-source', 'artifact-oversized'));
  });

  it.each([
    ['a value at depth 17', '['.repeat(17) + ']'.repeat(17), 'artifact-too-deep'],
    ['8,193 values', `[${Array.from({ length: 8_192 }, () => '0').join(',')}]`, 'artifact-too-many-values'],
    ['a duplicate key', fixClaimsText().replace('{', '{"pass":1,'), 'artifact-duplicate-key'],
    ['a key named __proto__', fixClaimsText().replace('{', '{"__proto__":{},'), 'artifact-forbidden-key'],
    ['text that is not JSON', 'all fixed', 'artifact-malformed'],
    ['a value that is not text', 7 as unknown as string, 'artifact-malformed']
  ])('refuses %s', (_label, text, detail) => {
    expect(parseFixClaims(text)).toEqual(refusal('invalid-source', detail));
  });

  it('refuses a key the contract does not name, and a missing key', () => {
    expect(parseFixClaims(claimsWith({ note: 'extra' }))).toEqual(refusal('invalid-source', 'claims-shape'));
    expect(parseFixClaims(JSON.stringify(without(fixClaims(), 'basedOnReportRef')))).toEqual(refusal('invalid-source', 'claims-shape'));
  });

  it.each([
    ['a loop identity with a space', { loopId: 'loop 1' }],
    ['pass zero', { pass: 0 }],
    ['a pass that is text', { pass: '1' }],
    ['a fixer attempt that is empty', { fixerAttemptId: '' }],
    ['a report reference with a space', { basedOnReportRef: 'report 1' }],
    ['a report reference that is null', { basedOnReportRef: null }],
    ['claims that are not a list', { claims: { 0: { findingId: 'F-1', claim: 'disputed' } } }]
  ])('refuses %s', (_label, fields) => {
    expect(parseFixClaims(claimsWith(fields))).toEqual(refusal('invalid-source', 'claims-field'));
  });

  it('accepts 200 claims and refuses 201', () => {
    expect(parseFixClaims(fixClaimsText({ claims: claims(200) })).ok).toBe(true);
    expect(parseFixClaims(fixClaimsText({ claims: claims(201) }))).toEqual(refusal('invalid-source', 'record-count'));
  });

  it('refuses a claim that is not a record, has a key too many or a key too few', () => {
    expect(parseFixClaims(claimsWith({ claims: ['F-1'] }))).toEqual(refusal('invalid-source', 'claim-shape'));
    expect(parseFixClaims(claimsWithClaim({ note: 'extra' }))).toEqual(refusal('invalid-source', 'claim-shape'));
    expect(parseFixClaims(claimsWith({ claims: [{ findingId: 'F-1' }] }))).toEqual(refusal('invalid-source', 'claim-shape'));
  });

  it('refuses a bad finding identity', () => {
    expect(parseFixClaims(claimsWithClaim({ findingId: 'F 1' }))).toEqual(refusal('invalid-source', 'finding-id'));
    expect(parseFixClaims(claimsWithClaim({ findingId: 7 }))).toEqual(refusal('invalid-source', 'finding-id'));
  });

  it.each([
    ['a kind the contract does not name', 'fixed'],
    ['a status in place of a kind', 'resolved'],
    ['a kind that is null', null]
  ])('refuses %s', (_label, claim) => {
    expect(parseFixClaims(claimsWithClaim({ claim }))).toEqual(refusal('invalid-source', 'claim-kind'));
  });

  it('refuses two claims for one finding', () => {
    const twice = [
      { findingId: 'F-1', claim: 'claimed-fixed' },
      { findingId: 'F-1', claim: 'disputed' }
    ];

    expect(parseFixClaims(claimsWith({ claims: twice }))).toEqual(refusal('invalid-source', 'claim-duplicate'));
  });

  it('refuses the whole set for one bad claim among good ones', () => {
    const mixed = [...claims(5), { findingId: 'F-9', claim: 'fixed' }];

    expect(parseFixClaims(claimsWith({ claims: mixed }))).toEqual(refusal('invalid-source', 'claim-kind'));
  });
});
