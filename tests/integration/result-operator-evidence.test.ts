// FR-R5-F24 (SPEC-02, D2, F24-T05) — Integration tests for workspace-contained
// regular-file evidence reading in ResultOperator: lexical escape paths, leaf and
// ancestor symlinks, directories/non-regular files, missing files, and oversize files.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RESULT_SOURCE_BYTES,
  freezeResultContract,
  type ResultContract
} from '../../src/contracts/decision-results';
import { evaluateAttemptOutcome, readContainedEvidenceFile } from '../../src/services/result-operator';

function contractAt(outputKey: string): ResultContract {
  return freezeResultContract({
    version: 1,
    operator: 'structured-result',
    operatorVersion: 1,
    fields: [
      {
        fieldId: 'verdict',
        type: 'string',
        required: true,
        selector: ['verdict']
      }
    ],
    source: {
      kind: 'declared-output',
      outputKey
    },
    completion: {
      version: 1,
      kind: 'typed',
      test: {
        left: { source: 'result-field', fieldId: 'verdict' },
        operator: 'equals',
        right: 'pass'
      }
    }
  });
}

describe('ResultOperator evidence containment and regular-file checks (F24-T02, F24-T05)', () => {
  let rootDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'schegent-f24-evidence-'));
    workspaceDir = join(rootDir, 'workspace');
    outsideDir = join(rootDir, 'outside');
    mkdirSync(join(workspaceDir, '.schegent', 'results'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, 'secret.json'),
      JSON.stringify({ attemptId: 'att-1', verdict: 'pass' }),
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('rejects lexical escape paths as malformed-evidence before opening', async () => {
    for (const escapePath of [
      '../outside/secret.json',
      '.schegent/../../outside/secret.json',
      '/etc/passwd',
      'C:\\outside\\secret.json',
      './result.json'
    ]) {
      const res = await readContainedEvidenceFile(workspaceDir, escapePath);
      expect(res.ok, `expected ${escapePath} to be rejected`).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('malformed-evidence');
      }
    }
  });

  it('rejects leaf symlinks and ancestor directory symlinks as malformed-evidence', async () => {
    const leafSymlink = join(workspaceDir, '.schegent', 'results', 'link-leaf.json');
    symlinkSync(join(outsideDir, 'secret.json'), leafSymlink);

    const leafOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-1',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/results/link-leaf.json')
    });
    expect(leafOutcome.status).toBe('invalid-result');
    expect(leafOutcome.reason).toBe('malformed-evidence');
    expect(leafOutcome.recovery).toBe('block-intervention');
    expect(leafOutcome.values).toEqual({});

    const dirSymlink = join(workspaceDir, '.schegent', 'linked-dir');
    symlinkSync(outsideDir, dirSymlink);

    const ancestorOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-1',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/linked-dir/secret.json')
    });
    expect(ancestorOutcome.status).toBe('invalid-result');
    expect(ancestorOutcome.reason).toBe('malformed-evidence');
    expect(ancestorOutcome.recovery).toBe('block-intervention');
  });

  it('rejects directories and FIFOs/named pipes as malformed-evidence without blocking', async () => {
    mkdirSync(join(workspaceDir, '.schegent', 'results', 'as-dir.json'), { recursive: true });
    const dirOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-1',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/results/as-dir.json')
    });
    expect(dirOutcome.status).toBe('invalid-result');
    expect(dirOutcome.reason).toBe('malformed-evidence');
    expect(dirOutcome.recovery).toBe('block-intervention');

    if (process.platform !== 'win32') {
      const fifoPath = join(workspaceDir, '.schegent', 'results', 'pipe.json');
      try {
        execFileSync('mkfifo', [fifoPath]);
      } catch {
        return;
      }
      const fifoOutcome = await evaluateAttemptOutcome({
        attemptId: 'att-1',
        workspaceRoot: workspaceDir,
        resultContract: contractAt('.schegent/results/pipe.json')
      });
      expect(fifoOutcome.status).toBe('invalid-result');
      expect(fifoOutcome.reason).toBe('malformed-evidence');
      expect(fifoOutcome.recovery).toBe('block-intervention');
    }
  });

  it('classifies missing files as missing-evidence and files exceeding 262,144 bytes as evidence-too-large', async () => {
    const missingOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-1',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/results/does-not-exist.json')
    });
    expect(missingOutcome.status).toBe('invalid-result');
    expect(missingOutcome.reason).toBe('missing-evidence');
    expect(missingOutcome.recovery).toBe('block-intervention');

    const oversizePath = join(workspaceDir, '.schegent', 'results', 'huge.json');
    writeFileSync(oversizePath, 'x'.repeat(MAX_RESULT_SOURCE_BYTES + 128), 'utf8');
    const oversizeOutcome = await evaluateAttemptOutcome({
      attemptId: 'att-1',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/results/huge.json')
    });
    expect(oversizeOutcome.status).toBe('invalid-result');
    expect(oversizeOutcome.reason).toBe('evidence-too-large');
    expect(oversizeOutcome.recovery).toBe('block-intervention');
  });

  it('reads and validates a contained regular JSON file with matching attemptId', async () => {
    const validPath = join(workspaceDir, '.schegent', 'results', 'ok.json');
    writeFileSync(
      validPath,
      JSON.stringify({ attemptId: 'att-77', verdict: 'pass' }),
      'utf8'
    );
    const outcome = await evaluateAttemptOutcome({
      attemptId: 'att-77',
      workspaceRoot: workspaceDir,
      resultContract: contractAt('.schegent/results/ok.json')
    });
    expect(outcome.status).toBe('done');
    expect(outcome.reason).toBe('completed');
    expect(outcome.recovery).toBe('none');
    expect(outcome.values).toEqual({ verdict: 'pass' });
    expect(outcome.provenance.evidenceRef).toMatch(/^ev-/);
  });
});
