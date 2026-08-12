// Feature 087 (T062, US6) — completion-time output resolution.
//
// FR-040 (resolve each declared target and record what resolved), FR-040a (a
// record is a location, never content), FR-041 (undeclared artifacts are not
// recorded), FR-042 (one unresolved output does not suppress the others).
//
// The existence probe is injected for the same reason the output-target
// validator injects one: what the rule does with the answer is the behaviour
// under test, and a real tree would only put setup between the case and its
// assertion.
//
// FR-041 is tested by handing the probe an existing artifact nobody declared.
// The resolver never enumerates a directory — it walks the frozen plan's
// declared outputs and nothing else — so an undeclared file cannot appear in
// the result no matter what the filesystem holds.

import { describe, expect, it } from 'vitest';
import type { FrozenOutputRequest } from '../../../../src/contracts/run-request';
import { resolveRunOutputs } from '../../../../src/services/run-output/run-output-resolver';

const WORKSPACE_ROOT = '/workspace';

function declared(
  portId: string,
  target: string,
  type: FrozenOutputRequest['type'] = 'markdown'
): FrozenOutputRequest {
  return { portId, type, target, overwriteConfirmed: false };
}

function probeFor(existing: readonly string[]) {
  const present = new Set(existing);
  const asked: string[] = [];
  return {
    asked,
    probe: {
      exists: async (absolutePath: string) => {
        asked.push(absolutePath);
        return present.has(absolutePath);
      }
    }
  };
}

async function resolve(
  outputs: readonly FrozenOutputRequest[],
  existing: readonly string[] = []
) {
  const { probe, asked } = probeFor(existing);
  const records = await resolveRunOutputs(outputs, { workspaceRoot: WORKSPACE_ROOT, probe });
  return { records, asked };
}

describe('a declared output that resolves (FR-040)', () => {
  it('records the output under its port identifier', async () => {
    const { records } = await resolve(
      [declared('report', 'out/report.md')],
      ['/workspace/out/report.md']
    );
    expect(records).toEqual([
      { name: 'report', status: 'resolved', reference: 'out/report.md' }
    ]);
  });

  it('records every declared output that resolved, in declaration order', async () => {
    const { records } = await resolve(
      [
        declared('report', 'out/report.md'),
        declared('summary', 'out/summary.txt', 'file'),
        declared('ticket', 'out/ticket.json', 'external-reference')
      ],
      ['/workspace/out/report.md', '/workspace/out/summary.txt', '/workspace/out/ticket.json']
    );
    expect(records.map((record) => record.name)).toEqual(['report', 'summary', 'ticket']);
    expect(records.every((record) => record.status === 'resolved')).toBe(true);
  });

  it('normalizes the recorded location so one file reads as one reference', async () => {
    const { records } = await resolve(
      [declared('report', './out/nested/../report.md')],
      ['/workspace/out/report.md']
    );
    expect(records[0]?.reference).toBe('out/report.md');
  });

  it('records nothing when the plan declared no outputs', async () => {
    const { records } = await resolve([], ['/workspace/out/report.md']);
    expect(records).toEqual([]);
  });
});

describe('a record is a location, never content (FR-040a)', () => {
  it('carries only a name, a status, and a workspace-relative reference', async () => {
    const { records } = await resolve(
      [declared('report', 'out/report.md')],
      ['/workspace/out/report.md']
    );
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(['name', 'reference', 'status']);
  });

  it('never records an absolute path', async () => {
    const { records } = await resolve(
      [declared('report', 'out/report.md')],
      ['/workspace/out/report.md']
    );
    expect(records[0]?.reference?.startsWith('/')).toBe(false);
    expect(records[0]?.reference).not.toContain(WORKSPACE_ROOT);
  });

  it('asks the probe only whether something is there, and reads nothing', async () => {
    // The seam is `exists`. There is no `read` on it, so content cannot enter a
    // record by way of this module even accidentally.
    const { probe } = probeFor(['/workspace/out/report.md']);
    expect(Object.keys(probe)).toEqual(['exists']);
    const records = await resolveRunOutputs([declared('report', 'out/report.md')], {
      workspaceRoot: WORKSPACE_ROOT,
      probe
    });
    expect(records[0]?.status).toBe('resolved');
  });
});

describe('an output that fails to resolve (FR-042)', () => {
  it('is recorded as unresolved rather than dropped', async () => {
    const { records } = await resolve([declared('report', 'out/report.md')], []);
    expect(records).toEqual([{ name: 'report', status: 'unresolved' }]);
  });

  it('carries no reference, so nothing downstream can feed it forward', async () => {
    const { records } = await resolve([declared('report', 'out/report.md')], []);
    expect(records[0]).not.toHaveProperty('reference');
  });

  it('does not suppress the outputs that did resolve', async () => {
    const { records } = await resolve(
      [
        declared('report', 'out/report.md'),
        declared('summary', 'out/summary.txt', 'file'),
        declared('ticket', 'out/ticket.json', 'external-reference')
      ],
      ['/workspace/out/report.md', '/workspace/out/ticket.json']
    );
    expect(records).toEqual([
      { name: 'report', status: 'resolved', reference: 'out/report.md' },
      { name: 'summary', status: 'unresolved' },
      { name: 'ticket', status: 'resolved', reference: 'out/ticket.json' }
    ]);
  });

  it('reports a target that escapes the workspace as unresolved without probing it', async () => {
    // Validation already refused such a target, so this is the defensive half:
    // a plan that somehow carries one must not send the probe outside the root.
    const { records, asked } = await resolve([declared('report', '../outside/report.md')]);
    expect(records).toEqual([{ name: 'report', status: 'unresolved' }]);
    expect(asked).toEqual([]);
  });

  it('reports an empty target as unresolved without probing it', async () => {
    const { records, asked } = await resolve([declared('report', '   ')]);
    expect(records).toEqual([{ name: 'report', status: 'unresolved' }]);
    expect(asked).toEqual([]);
  });
});

// Feature 091 (T002, US1) — the write contract of
// specs/091-process-platform-wiring/contracts/run-output-recording.md.
//
// The 087 cases above already pin most of W1/W2/W4 and containment-before-probe
// from the resolver's own side. What they do not pin is R2 under a *rejecting*
// probe: 087's fake can only answer true or false, so a probe that throws has
// never reached this loop. 091 puts a real filesystem behind it (T009), where a
// permission error is an ordinary Tuesday, and FR-006/FR-006a require that one
// such failure be recorded unresolved rather than abort the outputs after it.

describe('one check that fails does not stop the rest (R2, FR-006, FR-006a)', () => {
  function throwingProbeAt(failingPath: string, existing: readonly string[]) {
    const present = new Set(existing);
    const asked: string[] = [];
    return {
      asked,
      probe: {
        exists: async (absolutePath: string) => {
          asked.push(absolutePath);
          if (absolutePath === failingPath) {
            throw new Error('EACCES: permission denied');
          }
          return present.has(absolutePath);
        }
      }
    };
  }

  const THREE = [
    declared('report', 'out/report.md'),
    declared('summary', 'out/summary.txt', 'file'),
    declared('ticket', 'out/ticket.json', 'external-reference')
  ];

  it('records the failing check as unresolved and still records those after it', async () => {
    const { probe } = throwingProbeAt('/workspace/out/summary.txt', [
      '/workspace/out/report.md',
      '/workspace/out/ticket.json'
    ]);
    const records = await resolveRunOutputs(THREE, { workspaceRoot: WORKSPACE_ROOT, probe });
    expect(records).toEqual([
      { name: 'report', status: 'resolved', reference: 'out/report.md' },
      { name: 'summary', status: 'unresolved' },
      { name: 'ticket', status: 'resolved', reference: 'out/ticket.json' }
    ]);
  });

  it('asks about every declared output even when an earlier one threw', async () => {
    const { probe, asked } = throwingProbeAt('/workspace/out/report.md', []);
    await resolveRunOutputs(THREE, { workspaceRoot: WORKSPACE_ROOT, probe });
    expect(asked).toEqual([
      '/workspace/out/report.md',
      '/workspace/out/summary.txt',
      '/workspace/out/ticket.json'
    ]);
  });

  it('does not reject, so the completion transition is never gated on a probe', async () => {
    // FR-006: a failure to examine is recorded, never raised. If this rejected,
    // the caller in run-driver would have to guard it, and a guard is something
    // a later edit can drop.
    const { probe } = throwingProbeAt('/workspace/out/report.md', []);
    await expect(
      resolveRunOutputs([declared('report', 'out/report.md')], {
        workspaceRoot: WORKSPACE_ROOT,
        probe
      })
    ).resolves.toEqual([{ name: 'report', status: 'unresolved' }]);
  });

  it('records a failing check with no reference key', async () => {
    const { probe } = throwingProbeAt('/workspace/out/report.md', []);
    const records = await resolveRunOutputs([declared('report', 'out/report.md')], {
      workspaceRoot: WORKSPACE_ROOT,
      probe
    });
    expect(records[0]).not.toHaveProperty('reference');
  });

  it('records every output as unresolved when every check throws', async () => {
    const probe = {
      exists: async () => {
        throw new Error('EIO');
      }
    };
    const records = await resolveRunOutputs(THREE, { workspaceRoot: WORKSPACE_ROOT, probe });
    expect(records).toEqual([
      { name: 'report', status: 'unresolved' },
      { name: 'summary', status: 'unresolved' },
      { name: 'ticket', status: 'unresolved' }
    ]);
  });
});

describe('undeclared artifacts (FR-041)', () => {
  it('records nothing for an artifact the plan never declared', async () => {
    const { records } = await resolve(
      [declared('report', 'out/report.md')],
      [
        '/workspace/out/report.md',
        '/workspace/out/scratch.md',
        '/workspace/out/notes/incidental.txt'
      ]
    );
    expect(records.map((record) => record.name)).toEqual(['report']);
  });

  it('asks about the declared targets only', async () => {
    const { asked } = await resolve(
      [declared('report', 'out/report.md'), declared('summary', 'out/summary.txt', 'file')],
      ['/workspace/out/report.md', '/workspace/out/scratch.md']
    );
    expect(asked).toEqual(['/workspace/out/report.md', '/workspace/out/summary.txt']);
  });

  it('records nothing at all when the plan declared nothing, however full the tree', async () => {
    const { records, asked } = await resolve([], [
      '/workspace/out/a.md',
      '/workspace/out/b.md'
    ]);
    expect(records).toEqual([]);
    expect(asked).toEqual([]);
  });
});
