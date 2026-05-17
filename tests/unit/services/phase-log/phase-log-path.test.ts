// Feature 020 T012 — tuple → path resolution. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §1.
//
// Feature 034 T001 — added regression coverage for the two new pure
// helpers (`resolveSessionRootPath`, `resolveRawTranscriptPath`) and a
// byte-for-byte equivalence check on `resolvePhaseDirPath` after it
// was refactored to delegate the `.schegent/sessions/<runId>/` prefix
// composition to `resolveSessionRootPath`.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveStreamJsonlPath,
  resolvePhaseDirPath,
  resolveSessionRootPath,
  resolveRawTranscriptPath
} from '../../../../src/services/phase-log/phase-log-path';

const WS = '/abs/workspace';

describe('Feature 020 T012 — resolveStreamJsonlPath / resolvePhaseDirPath', () => {
  it('returns the expected absolute path for stream.jsonl', () => {
    const p = resolveStreamJsonlPath({
      workspaceRoot: WS,
      runId: 'run-1',
      pipelineId: 'pipe-1',
      phaseId: 'phase-1',
      iterationN: 3
    });
    const expected = path.join(
      WS,
      '.schegent',
      'sessions',
      'run-1',
      'diagnostics',
      'pipe-1',
      'phase-1',
      'iter-3',
      'stream.jsonl'
    );
    expect(p).toBe(expected);
  });

  it('returns the expected absolute path for the phase dir', () => {
    const p = resolvePhaseDirPath({
      workspaceRoot: WS,
      runId: 'run-1',
      pipelineId: 'pipe-1',
      phaseId: 'phase-1'
    });
    const expected = path.join(
      WS,
      '.schegent',
      'sessions',
      'run-1',
      'diagnostics',
      'pipe-1',
      'phase-1'
    );
    expect(p).toBe(expected);
  });

  it('throws RangeError if iterationN < 1', () => {
    expect(() =>
      resolveStreamJsonlPath({
        workspaceRoot: WS,
        runId: 'r',
        pipelineId: 'p1',
        phaseId: 'p2',
        iterationN: 0
      })
    ).toThrow(RangeError);
    expect(() =>
      resolveStreamJsonlPath({
        workspaceRoot: WS,
        runId: 'r',
        pipelineId: 'p1',
        phaseId: 'p2',
        iterationN: -1
      })
    ).toThrow(RangeError);
  });

  it('throws TypeError if any string arg is empty', () => {
    expect(() =>
      resolveStreamJsonlPath({
        workspaceRoot: '',
        runId: 'r',
        pipelineId: 'p1',
        phaseId: 'p2',
        iterationN: 1
      })
    ).toThrow(TypeError);
    expect(() =>
      resolveStreamJsonlPath({
        workspaceRoot: WS,
        runId: '',
        pipelineId: 'p1',
        phaseId: 'p2',
        iterationN: 1
      })
    ).toThrow(TypeError);
    expect(() =>
      resolvePhaseDirPath({
        workspaceRoot: WS,
        runId: 'r',
        pipelineId: '',
        phaseId: 'p2'
      })
    ).toThrow(TypeError);
    expect(() =>
      resolvePhaseDirPath({
        workspaceRoot: WS,
        runId: 'r',
        pipelineId: 'p1',
        phaseId: ''
      })
    ).toThrow(TypeError);
  });
});

describe('Feature 034 T001 — resolveSessionRootPath / resolveRawTranscriptPath', () => {
  it('resolveSessionRootPath returns <workspaceRoot>/.schegent/sessions/<runId>', () => {
    const p = resolveSessionRootPath({ workspaceRoot: '/r', runId: 'X' });
    expect(p).toBe(path.join('/r', '.schegent', 'sessions', 'X'));
  });

  it('resolveSessionRootPath throws TypeError on empty workspaceRoot', () => {
    expect(() => resolveSessionRootPath({ workspaceRoot: '', runId: 'X' })).toThrow(
      TypeError
    );
  });

  it('resolveSessionRootPath throws TypeError on empty runId', () => {
    expect(() => resolveSessionRootPath({ workspaceRoot: '/r', runId: '' })).toThrow(
      TypeError
    );
  });

  it('resolveRawTranscriptPath returns <workspaceRoot>/.schegent/sessions/raw-<runId>.log', () => {
    const p = resolveRawTranscriptPath({ workspaceRoot: '/r', runId: 'X' });
    expect(p).toBe(path.join('/r', '.schegent', 'sessions', 'raw-X.log'));
  });

  it('resolveRawTranscriptPath throws TypeError on empty workspaceRoot', () => {
    expect(() => resolveRawTranscriptPath({ workspaceRoot: '', runId: 'X' })).toThrow(
      TypeError
    );
  });

  it('resolveRawTranscriptPath throws TypeError on empty runId', () => {
    expect(() => resolveRawTranscriptPath({ workspaceRoot: '/r', runId: '' })).toThrow(
      TypeError
    );
  });

  it('resolvePhaseDirPath composition is byte-for-byte equivalent after the refactor', () => {
    // Regression: even though resolvePhaseDirPath now delegates the
    // session-root prefix to resolveSessionRootPath, the joined path
    // must remain identical to the pre-refactor path-join chain.
    const refactored = resolvePhaseDirPath({
      workspaceRoot: WS,
      runId: 'run-Z',
      pipelineId: 'pipe-Z',
      phaseId: 'phase-Z'
    });
    const expected = path.join(
      WS,
      '.schegent',
      'sessions',
      'run-Z',
      'diagnostics',
      'pipe-Z',
      'phase-Z'
    );
    expect(refactored).toBe(expected);
  });
});
