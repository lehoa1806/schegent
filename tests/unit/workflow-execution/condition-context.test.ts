// Feature 088 (T009) — what a condition may read, and nothing else.
//
// The context is the whole attack surface of evaluation: a condition cannot
// reach a fact the context does not hold. So the interesting assertions here are
// all negative — an output that was not declared, an output of a node that has
// not completed, a metadata member that is not `status`, and file content, are
// each unreadable — plus a source scan proving the module has no way to read a
// file even if a later contributor wanted one.
//
// contracts/condition-context.md is the contract these tests pin.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDITION_CONTEXT_RUN_METADATA,
  buildConditionContext,
  resolveOperand
} from '../../../src/services/workflow-execution/condition-context';
import type { NodeAttemptFacts } from '../../../src/services/workflow-execution/condition-context';
import { WORKFLOW_NODE_TERMINAL_STATUSES } from '../../../src/contracts/workflow-definitions';

const SOURCE_PATH = join(__dirname, '../../../src/services/workflow-execution/condition-context.ts');

const COMPLETED: NodeAttemptFacts = {
  nodeId: 'n-triage',
  status: 'completed',
  outputs: [
    { name: 'report', status: 'resolved', reference: 'docs/report.md' },
    { name: 'summary', status: 'unresolved' }
  ]
};

const FAILED: NodeAttemptFacts = {
  nodeId: 'n-build',
  status: 'failed',
  outputs: [{ name: 'artifact', status: 'resolved', reference: 'dist/app.tgz' }]
};

function context(...facts: readonly NodeAttemptFacts[]) {
  return buildConditionContext(facts);
}

describe('the readable context: declared outputs', () => {
  it('resolves a declared output of a completed attempt to its location reference', () => {
    expect(
      resolveOperand({ source: 'node-output', nodeId: 'n-triage', field: 'report' }, context(COMPLETED))
    ).toEqual({ resolved: true, value: 'docs/report.md' });
  });

  it('leaves an output the run never produced unresolved', () => {
    expect(
      resolveOperand(
        { source: 'node-output', nodeId: 'n-triage', field: 'summary' },
        context(COMPLETED)
      )
    ).toEqual({ resolved: false });
  });

  it('leaves an undeclared output name unresolved', () => {
    expect(
      resolveOperand(
        { source: 'node-output', nodeId: 'n-triage', field: 'not-declared' },
        context(COMPLETED)
      )
    ).toEqual({ resolved: false });
  });

  it('leaves every output of a node that did not complete unresolved', () => {
    // Its `status` is readable — routing on failure is the point of FR-050 —
    // but the outputs of an attempt that did not complete are not.
    const built = context(FAILED);
    expect(
      resolveOperand({ source: 'node-output', nodeId: 'n-build', field: 'artifact' }, built)
    ).toEqual({ resolved: false });
    expect(resolveOperand({ source: 'node-status', nodeId: 'n-build' }, built)).toEqual({
      resolved: true,
      value: 'failed'
    });
  });

  it('leaves a node with no recorded attempt unresolved for both sources', () => {
    const built = context(COMPLETED);
    expect(
      resolveOperand({ source: 'node-output', nodeId: 'n-absent', field: 'report' }, built)
    ).toEqual({ resolved: false });
    expect(resolveOperand({ source: 'node-status', nodeId: 'n-absent' }, built)).toEqual({
      resolved: false
    });
  });

  it('refuses to hold two attempts of the same node, so values cannot mix (FR-037)', () => {
    expect(() =>
      context(COMPLETED, { ...COMPLETED, outputs: [{ name: 'report', status: 'unresolved' }] })
    ).toThrow(/n-triage/);
  });
});

describe('the readable context: run metadata is a closed one-member set', () => {
  it('has exactly one member, and it is status', () => {
    expect(CONDITION_CONTEXT_RUN_METADATA).toEqual(['status']);
  });

  it('resolves every terminal status the definition side can name', () => {
    for (const status of WORKFLOW_NODE_TERMINAL_STATUSES) {
      const built = context({ nodeId: 'n', status, outputs: [] });
      expect(resolveOperand({ source: 'node-status', nodeId: 'n' }, built)).toEqual({
        resolved: true,
        value: status
      });
    }
  });

  it('carries no fact beyond the declared outputs and that one member', () => {
    // A timestamp is the tempting fourth field, and it is absent on purpose: no
    // operand source can address one, so it would be a dead surface a later
    // contributor half-wires in (contracts/condition-context.md).
    const facts = context(COMPLETED).nodes['n-triage'];
    expect(Object.keys(facts ?? {}).sort()).toEqual(['nodeId', 'outputs', 'status']);
  });
});

describe('no file content is ever read', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it('imports no filesystem, host, or process module', () => {
    for (const forbidden of [
      /from ['"]node:fs['"]/,
      /from ['"]fs['"]/,
      /from ['"]node:fs\/promises['"]/,
      /from ['"]vscode['"]/,
      /from ['"]node:child_process['"]/,
      /require\(/
    ]) {
      expect(source, `condition-context.ts must not match ${String(forbidden)}`).not.toMatch(
        forbidden
      );
    }
  });

  it('contains no read, spawn, or evaluate call', () => {
    for (const forbidden of [
      /readFile/,
      /readFileSync/,
      /createReadStream/,
      /\bexec\(/,
      /\bspawn\(/,
      /\beval\(/,
      /new Function\(/
    ]) {
      expect(source, `condition-context.ts must not match ${String(forbidden)}`).not.toMatch(
        forbidden
      );
    }
  });

  it('exposes the reference, never anything derived from opening it', () => {
    // The value a condition compares against is the recorded location string as
    // persisted — same bytes, no normalization, no resolution against a root.
    const reference = 'docs/nested/report with spaces.md';
    const built = context({
      nodeId: 'n',
      status: 'completed',
      outputs: [{ name: 'out', status: 'resolved', reference }]
    });
    expect(resolveOperand({ source: 'node-output', nodeId: 'n', field: 'out' }, built)).toEqual({
      resolved: true,
      value: reference
    });
  });
});
