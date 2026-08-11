// Feature 087 (T029) — prior-output references.
//
// FR-026 (a supplemental input may reference a named output of a prior Run),
// FR-027 (resolved at validation time; refused when it cannot be), FR-028 (the
// resolved location is frozen, so later changes to the source Run do not
// retarget it), FR-028a (structured data compared field-wise — no string form,
// no grammar, no parser).
//
// FR-028a is the one with a test that looks like paranoia and is not: the
// project settled the same question for Workflow conditions, and the failure
// mode is identical. A string form needs a grammar, a grammar needs a parser,
// and the parser then runs over operator-authored content.

import { describe, expect, it } from 'vitest';
import type { RunOutputRecord } from '../../../../src/contracts/run-results';
import {
  resolvePriorOutput,
  type PriorRunOutputSource
} from '../../../../src/services/run-request/output-reference-resolver';

function sourceOf(runs: Record<string, readonly RunOutputRecord[]>): PriorRunOutputSource {
  return { outputsFor: (runId) => runs[runId] ?? null };
}

const RESOLVED: RunOutputRecord = {
  name: 'report',
  status: 'resolved',
  reference: 'runs/run-1/report.md'
};

describe('resolvePriorOutput', () => {
  it('resolves a named output of a known Run', () => {
    const source = sourceOf({ 'run-1': [RESOLVED] });
    expect(resolvePriorOutput(source, { sourceRunId: 'run-1', outputName: 'report' })).toEqual({
      ok: true,
      reference: 'runs/run-1/report.md'
    });
  });

  it('picks the output by name, not by position', () => {
    const source = sourceOf({
      'run-1': [
        { name: 'summary', status: 'resolved', reference: 'runs/run-1/summary.md' },
        RESOLVED
      ]
    });
    expect(resolvePriorOutput(source, { sourceRunId: 'run-1', outputName: 'report' })).toEqual({
      ok: true,
      reference: 'runs/run-1/report.md'
    });
  });

  it('refuses a Run that does not exist', () => {
    const source = sourceOf({ 'run-1': [RESOLVED] });
    expect(resolvePriorOutput(source, { sourceRunId: 'run-9', outputName: 'report' })).toEqual({
      ok: false,
      code: 'prior-run-not-found'
    });
  });

  it('refuses an output name the source Run does not have', () => {
    const source = sourceOf({ 'run-1': [RESOLVED] });
    expect(resolvePriorOutput(source, { sourceRunId: 'run-1', outputName: 'ghost' })).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  // The output is declared and named, and the Phases never produced it. There is
  // nothing to feed forward, so this refuses rather than freezing an absent
  // location — the same answer as a missing name, from a different cause.
  it('refuses an output the source Run recorded as unresolved', () => {
    const source = sourceOf({ 'run-1': [{ name: 'report', status: 'unresolved' }] });
    expect(resolvePriorOutput(source, { sourceRunId: 'run-1', outputName: 'report' })).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  it('refuses a Run with no recorded outputs', () => {
    expect(resolvePriorOutput(sourceOf({ 'run-1': [] }), {
      sourceRunId: 'run-1',
      outputName: 'report'
    })).toEqual({ ok: false, code: 'prior-output-not-found' });
  });

  it.each([
    ['', 'report'],
    ['run-1', ''],
    ['', '']
  ])('refuses the empty reference (%p, %p)', (sourceRunId, outputName) => {
    expect(resolvePriorOutput(sourceOf({ 'run-1': [RESOLVED] }), { sourceRunId, outputName }).ok).toBe(
      false
    );
  });
});

describe('field-wise comparison (FR-028a)', () => {
  // Each of these is a separator a string form would have had to mean something
  // by. Here they are ordinary characters in a name, matched literally.
  it.each(['run/1', 'run:1', 'run#1', 'run.1', 'run 1'])(
    'matches a Run identifier containing %p literally',
    (sourceRunId) => {
      const source = sourceOf({ [sourceRunId]: [RESOLVED] });
      expect(resolvePriorOutput(source, { sourceRunId, outputName: 'report' })).toEqual({
        ok: true,
        reference: 'runs/run-1/report.md'
      });
    }
  );

  it('does not treat a composite string as a reference', () => {
    const source = sourceOf({ 'run-1': [RESOLVED] });
    expect(
      resolvePriorOutput(source, { sourceRunId: 'run-1#report', outputName: '' })
    ).toEqual({ ok: false, code: 'prior-run-not-found' });
  });

  it('compares names exactly, without case folding or trimming', () => {
    const source = sourceOf({ 'run-1': [RESOLVED] });
    for (const outputName of ['Report', 'REPORT', ' report', 'report ']) {
      expect(resolvePriorOutput(source, { sourceRunId: 'run-1', outputName })).toEqual({
        ok: false,
        code: 'prior-output-not-found'
      });
    }
  });
});
