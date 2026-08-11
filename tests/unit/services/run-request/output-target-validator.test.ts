// Feature 087 (T027, US6) — declared output targets.
//
// FR-021 (a declared output with no target), FR-022 (the same boundary rules as
// input references), FR-023 (overwrite needs confirmation), FR-024 (two outputs,
// one target), FR-025 (an external side effect needs its own confirmation).
//
// The existence probe is injected rather than reaching for `fs`: what these
// rules do with the answer is the behaviour under test, and a real tree would
// only add setup between the case and its assertion. The probe's own filesystem
// implementation is covered where it is defined.

import { describe, expect, it } from 'vitest';
import type { PipelineOutputPort } from '../../../../src/contracts/pipeline-definitions';
import type { RunOutputTargetRequest } from '../../../../src/contracts/run-request';
import { validateOutputTargets } from '../../../../src/services/run-request/output-target-validator';

const WORKSPACE_ROOT = '/workspace';

const REPORT: PipelineOutputPort = { portId: 'report', label: 'Report', type: 'markdown' };
const SUMMARY: PipelineOutputPort = { portId: 'summary', label: 'Summary', type: 'file' };
const EXTERNAL: PipelineOutputPort = {
  portId: 'ticket',
  label: 'Ticket',
  type: 'external-reference'
};

function probeFor(existing: readonly string[] = {} as readonly string[]) {
  const present = new Set(existing);
  return { exists: async (absolutePath: string) => present.has(absolutePath) };
}

async function validate(
  requested: readonly RunOutputTargetRequest[],
  ports: readonly PipelineOutputPort[],
  existing: readonly string[] = []
) {
  return validateOutputTargets({
    requested,
    ports,
    workspaceRoot: WORKSPACE_ROOT,
    probe: probeFor(existing)
  });
}

function codes(result: Awaited<ReturnType<typeof validate>>) {
  return result.errors.map(({ field, code }) => ({ field, code }));
}

describe('a declared output with no target (FR-021)', () => {
  it('accepts every declared output given a target', async () => {
    const result = await validate(
      [
        { portId: 'report', target: 'out/report.md' },
        { portId: 'summary', target: 'out/summary.txt' }
      ],
      [REPORT, SUMMARY]
    );
    expect(result.errors).toEqual([]);
  });

  it('refuses a declared output the request omits', async () => {
    const result = await validate([{ portId: 'report', target: 'out/report.md' }], [REPORT, SUMMARY]);
    expect(codes(result)).toEqual([{ field: 'outputs.summary', code: 'output-target-missing' }]);
  });

  it.each(['', '   '])('refuses a target of %p', async (target) => {
    const result = await validate([{ portId: 'report', target }], [REPORT]);
    expect(codes(result)).toEqual([{ field: 'outputs.report', code: 'output-target-missing' }]);
  });

  it('refuses a target for a port the Pipeline does not declare', async () => {
    const result = await validate(
      [
        { portId: 'report', target: 'out/report.md' },
        { portId: 'ghost', target: 'out/ghost.md' }
      ],
      [REPORT]
    );
    expect(codes(result)).toEqual([{ field: 'outputs.ghost', code: 'unknown-output-port' }]);
  });

  it('refuses the same output port targeted twice', async () => {
    const result = await validate(
      [
        { portId: 'report', target: 'out/a.md' },
        { portId: 'report', target: 'out/b.md' }
      ],
      [REPORT]
    );
    expect(codes(result)).toEqual([{ field: 'outputs.report', code: 'unknown-output-port' }]);
  });
});

describe('the workspace boundary (FR-022)', () => {
  it.each(['../outside.md', '/etc/passwd', '/workspace-evil/report.md'])(
    'refuses the target %s',
    async (target) => {
      const result = await validate([{ portId: 'report', target }], [REPORT]);
      expect(codes(result)).toEqual([
        { field: 'outputs.report', code: 'path-escapes-workspace' }
      ]);
    }
  );
});

describe('overwrite confirmation (FR-023)', () => {
  it('refuses an unconfirmed overwrite of existing content', async () => {
    const result = await validate([{ portId: 'report', target: 'out/report.md' }], [REPORT], [
      '/workspace/out/report.md'
    ]);
    expect(codes(result)).toEqual([
      { field: 'outputs.report', code: 'output-overwrite-unconfirmed' }
    ]);
  });

  it('accepts a confirmed overwrite, and freezes the confirmation', async () => {
    const result = await validate(
      [{ portId: 'report', target: 'out/report.md', overwriteConfirmed: true }],
      [REPORT],
      ['/workspace/out/report.md']
    );
    expect(result.errors).toEqual([]);
    expect(result.outputs).toEqual([
      { portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: true }
    ]);
  });

  it('does not require confirmation when nothing is there', async () => {
    const result = await validate([{ portId: 'report', target: 'out/report.md' }], [REPORT]);
    expect(result.errors).toEqual([]);
    expect(result.outputs[0]).toMatchObject({ overwriteConfirmed: false });
  });
});

describe('two outputs, one target (FR-024)', () => {
  it('refuses two outputs naming the same target', async () => {
    const result = await validate(
      [
        { portId: 'report', target: 'out/shared.md' },
        { portId: 'summary', target: 'out/shared.md' }
      ],
      [REPORT, SUMMARY]
    );
    expect(codes(result)).toEqual([
      { field: 'outputs.summary', code: 'output-target-duplicate' }
    ]);
  });

  // The collision is on the resolved path, not the typed string: `out/a.md` and
  // `./out/nested/../a.md` are one file.
  it('refuses two targets that differ textually but resolve to one path', async () => {
    const result = await validate(
      [
        { portId: 'report', target: 'out/a.md' },
        { portId: 'summary', target: './out/nested/../a.md' }
      ],
      [REPORT, SUMMARY]
    );
    expect(codes(result)).toEqual([
      { field: 'outputs.summary', code: 'output-target-duplicate' }
    ]);
  });
});

describe('external side effects (FR-025)', () => {
  it('refuses an unconfirmed external side effect', async () => {
    const result = await validate([{ portId: 'ticket', target: 'out/ticket.md' }], [EXTERNAL]);
    expect(codes(result)).toEqual([
      { field: 'outputs.ticket', code: 'output-side-effect-unconfirmed' }
    ]);
  });

  it('accepts a confirmed external side effect', async () => {
    const result = await validate(
      [{ portId: 'ticket', target: 'out/ticket.md', externalSideEffectConfirmed: true }],
      [EXTERNAL]
    );
    expect(result.errors).toEqual([]);
  });

  it('does not ask for a side-effect confirmation on an ordinary output', async () => {
    const result = await validate([{ portId: 'report', target: 'out/report.md' }], [REPORT]);
    expect(result.errors).toEqual([]);
  });

  // Two confirmations are two decisions. Reporting only the first would make the
  // operator confirm, resubmit, and discover the second — the round trip FR-013
  // exists to prevent.
  it('reports an unconfirmed overwrite and an unconfirmed side effect together', async () => {
    const result = await validate([{ portId: 'ticket', target: 'out/ticket.md' }], [EXTERNAL], [
      '/workspace/out/ticket.md'
    ]);
    expect(codes(result)).toEqual([
      { field: 'outputs.ticket', code: 'output-overwrite-unconfirmed' },
      { field: 'outputs.ticket', code: 'output-side-effect-unconfirmed' }
    ]);
  });
});

describe('the frozen outputs', () => {
  it('carries the port type resolved from the Pipeline, not from the request', async () => {
    const result = await validate(
      [
        { portId: 'summary', target: 'out/summary.txt' },
        { portId: 'report', target: 'out/report.md' }
      ],
      [REPORT, SUMMARY]
    );
    expect(result.outputs).toEqual([
      { portId: 'summary', type: 'file', target: 'out/summary.txt', overwriteConfirmed: false },
      { portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: false }
    ]);
  });

  it('carries no absolute path — the target stays as the operator wrote it', async () => {
    const result = await validate([{ portId: 'report', target: 'out/report.md' }], [REPORT]);
    expect(JSON.stringify(result.outputs)).not.toContain(WORKSPACE_ROOT);
  });
});
