// Feature 087 (T064, US6, FR-043) — recorded named outputs reach Run details.
//
// The projection is the seam where a Run's `runOutputs` becomes something the
// webview reads, so it is also the seam where the two standing rules about that
// boundary apply: an operator-authored string is sanitized before it crosses
// (the port identifier comes from the Pipeline they wrote, the reference from
// the target they typed), and what crosses is a location, never content
// (FR-040a).
//
// Absence is asserted as a *missing key*, not as `undefined`. The snapshot is
// serialized to the webview, and `{ runOutputs: undefined }` and a Run that
// recorded none are the same JSON — but they are not the same object, and every
// other additive field on this snapshot uses the spread form for exactly that
// reason.

import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import type { RunOutputRecord } from '../../../../src/contracts/run-results';
import { projectRunOutputs } from '../../../../src/ui/sidebar/run-projector';

const logger = new SanitizedLogger();
const sanitize = (value: string): string => logger.sanitize(value);

function runWith(outputs?: readonly RunOutputRecord[]): WorkflowRun {
  return {
    ...(outputs !== undefined ? { runOutputs: outputs } : {})
  } as unknown as WorkflowRun;
}

describe('a Run that recorded no outputs', () => {
  it('projects no key at all', () => {
    expect(projectRunOutputs(runWith(), sanitize)).toEqual({});
  });

  it('projects no key when there is no run', () => {
    expect(projectRunOutputs(null, sanitize)).toEqual({});
  });

  it('projects an empty list when the Run declared outputs and recorded none', () => {
    expect(projectRunOutputs(runWith([]), sanitize)).toEqual({ runOutputs: [] });
  });
});

describe('recorded outputs (FR-043)', () => {
  it('projects resolved and unresolved records in the order recorded', () => {
    const projected = projectRunOutputs(
      runWith([
        { name: 'report', status: 'resolved', reference: 'out/report.md' },
        { name: 'summary', status: 'unresolved' },
        { name: 'ticket', status: 'resolved', reference: 'out/ticket.json' }
      ]),
      sanitize
    );
    expect(projected.runOutputs).toEqual([
      { name: 'report', status: 'resolved', reference: 'out/report.md' },
      { name: 'summary', status: 'unresolved' },
      { name: 'ticket', status: 'resolved', reference: 'out/ticket.json' }
    ]);
  });

  it('carries no reference key for an unresolved output', () => {
    const projected = projectRunOutputs(runWith([{ name: 'summary', status: 'unresolved' }]), sanitize);
    expect(projected.runOutputs?.[0]).not.toHaveProperty('reference');
  });

  it('projects a location and nothing that could hold content (FR-040a)', () => {
    const projected = projectRunOutputs(
      runWith([{ name: 'report', status: 'resolved', reference: 'out/report.md' }]),
      sanitize
    );
    expect(Object.keys(projected.runOutputs?.[0] ?? {}).sort()).toEqual([
      'name',
      'reference',
      'status'
    ]);
  });

  it('freezes what it projects', () => {
    const projected = projectRunOutputs(
      runWith([{ name: 'report', status: 'resolved', reference: 'out/report.md' }]),
      sanitize
    );
    expect(Object.isFrozen(projected.runOutputs)).toBe(true);
    expect(Object.isFrozen(projected.runOutputs?.[0])).toBe(true);
  });
});

describe('operator-authored strings are sanitized before they cross', () => {
  it('redacts a secret that reached a recorded reference', () => {
    const projected = projectRunOutputs(
      runWith([
        {
          name: 'report',
          status: 'resolved',
          reference: 'out/sk-ant-1234567890abcdef1234567890abcdef.md'
        }
      ]),
      sanitize
    );
    expect(projected.runOutputs?.[0]?.reference).not.toContain('sk-ant-1234567890');
    expect(projected.runOutputs?.[0]?.reference).toContain('[REDACTED]');
  });

  it('redacts a secret that reached a port identifier', () => {
    const projected = projectRunOutputs(
      runWith([{ name: 'SECRET=xyz_super_secret_value_1234', status: 'unresolved' }]),
      sanitize
    );
    expect(projected.runOutputs?.[0]?.name).not.toContain('xyz_super_secret_value_1234');
  });

  it('caps both fields so one Run cannot inflate the snapshot', () => {
    const projected = projectRunOutputs(
      runWith([{ name: 'n'.repeat(500), status: 'resolved', reference: 'r'.repeat(2_000) }]),
      sanitize
    );
    expect(projected.runOutputs?.[0]?.name.length).toBeLessThanOrEqual(64);
    expect(projected.runOutputs?.[0]?.reference?.length).toBeLessThanOrEqual(512);
  });
});
