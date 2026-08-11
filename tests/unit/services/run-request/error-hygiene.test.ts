// Feature 087 (T031, US2, FR-020, SC-005) — what a refusal is allowed to say.
//
// An operator who mistyped a path needs to know which field was wrong. They do
// not need to know where the host looked, and the webview must not be told:
// a resolved absolute path in an error message leaks the workspace layout
// across the IPC boundary, and from there into anything that renders or logs
// the response.
//
// This drives one deliberately awful request through the composed validator so
// that as many codes as possible fire at once, then asserts over every message
// produced. It is written as a sweep rather than a per-code assertion because
// the risk is a *future* message — the one someone adds with the resolved path
// interpolated in because it was right there in scope.

import { describe, expect, it } from 'vitest';
import type { PipelineInputPort, PipelineOutputPort } from '../../../../src/contracts/pipeline-definitions';
import type { RunRequest } from '../../../../src/contracts/run-request';
import { MAX_DESCRIPTION_LENGTH } from '../../../../src/queue/feature-request';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../../src/services/run-request/run-request-validator';

const WORKSPACE_ROOT = '/Users/someone/workspaces/private-client-work';

const INPUT_PORTS: readonly PipelineInputPort[] = [
  { portId: 'brief', label: 'Brief', type: 'text', required: true },
  { portId: 'spec', label: 'Spec', type: 'local-file', required: true },
  { portId: 'corpus', label: 'Corpus', type: 'local-folder', required: true },
  { portId: 'site', label: 'Site', type: 'web-url', required: true },
  { portId: 'fed', label: 'Fed', type: 'pipeline-output' }
];

const OUTPUT_PORTS: readonly PipelineOutputPort[] = [
  { portId: 'report', label: 'Report', type: 'markdown' },
  { portId: 'summary', label: 'Summary', type: 'file' },
  { portId: 'ticket', label: 'Ticket', type: 'external-reference' }
];

const PIPELINE: EffectivePipelineSource = {
  definition: {
    id: 'ab-flow',
    name: 'A then B',
    phases: ['alpha'],
    inputs: INPUT_PORTS,
    outputs: OUTPUT_PORTS
  },
  phases: [{ id: 'alpha', name: 'Alpha', instruction: 'Do the thing.', sourceScope: 'built-in' }]
};

/** Every path-bearing check refuses, so every path-bearing message is produced. */
const REFUSING_PORTS = {
  localInputs: {
    checkFile: async () => ({ ok: false, code: 'file-not-found' }) as const,
    checkFolder: async () =>
      ({ ok: false, code: 'folder-file-count-exceeded', limit: 500, actual: 501 }) as const
  },
  outputProbe: { exists: async () => true },
  priorOutputs: { outputsFor: () => null }
};

const HOSTILE_REQUEST: RunRequest = {
  pipelineId: 'ab-flow',
  inputs: [
    { portId: 'spec', type: 'local-file', value: '../../../etc/passwd' },
    { portId: 'corpus', type: 'local-folder', value: 'corpus' },
    { portId: 'site', type: 'web-url', value: 'file:///etc/shadow' },
    { portId: 'fed', type: 'pipeline-output', value: 'x' },
    { portId: 'ghost', type: 'text', value: 'x' }
  ],
  supplemental: [
    { kind: 'local-file', path: '/etc/hosts' },
    { kind: 'local-folder', path: '../..' },
    { kind: 'url', url: 'javascript:alert(1)' },
    { kind: 'prior-output', reference: { sourceRunId: 'gone', outputName: 'report' } }
  ],
  outputs: [
    { portId: 'report', target: '../escape.md' },
    { portId: 'summary', target: '' },
    { portId: 'ticket', target: 'out/ticket.md' }
  ],
  instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)
};

async function refusalMessages(workspaceRoot: string | null): Promise<readonly string[]> {
  const outcome = await validateRunRequest(HOSTILE_REQUEST, {
    pipeline: PIPELINE,
    workspaceRoot,
    now: 1,
    ...REFUSING_PORTS
  });
  expect(outcome.ok).toBe(false);
  return outcome.ok ? [] : outcome.errors.map((error) => error.message);
}

describe('validation error hygiene (FR-020)', () => {
  it('produces enough refusals for the sweep to be meaningful', async () => {
    const messages = await refusalMessages(WORKSPACE_ROOT);
    expect(messages.length).toBeGreaterThanOrEqual(10);
  });

  it('never names the workspace root', async () => {
    for (const message of await refusalMessages(WORKSPACE_ROOT)) {
      expect(message).not.toContain(WORKSPACE_ROOT);
      expect(message).not.toContain('private-client-work');
    }
  });

  it('never contains an absolute path', async () => {
    for (const message of await refusalMessages(WORKSPACE_ROOT)) {
      expect(message).not.toMatch(/(?:^|[\s"'(])(?:\/|[A-Za-z]:\\)/);
    }
  });

  // The supplied values are the other half: a message that echoed the offending
  // path back would leak `/etc/passwd` just as surely as echoing the root.
  it('never echoes a supplied path or URL back', async () => {
    for (const message of await refusalMessages(WORKSPACE_ROOT)) {
      for (const supplied of [
        '../../../etc/passwd',
        '/etc/hosts',
        '/etc/shadow',
        'javascript:alert(1)',
        '../escape.md'
      ]) {
        expect(message).not.toContain(supplied);
      }
    }
  });

  it('holds when there is no workspace root at all', async () => {
    const messages = await refusalMessages(null);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toMatch(/(?:^|[\s"'(])(?:\/|[A-Za-z]:\\)/);
    }
  });

  it('still identifies the offending field for every refusal', async () => {
    const outcome = await validateRunRequest(HOSTILE_REQUEST, {
      pipeline: PIPELINE,
      workspaceRoot: WORKSPACE_ROOT,
      now: 1,
      ...REFUSING_PORTS
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    for (const error of outcome.errors) {
      expect(error.field.length).toBeGreaterThan(0);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
