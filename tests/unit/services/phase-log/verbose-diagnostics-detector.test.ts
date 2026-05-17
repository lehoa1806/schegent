// Feature 020 T017 — `detectVerboseDiagnosticsState`: 3 banner kinds
// resolved correctly from setting × phaseDir existence permutations.
// See specs/020-phase-level-logs/contracts/phase-log-service.md §8.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectVerboseDiagnosticsState } from '../../../../src/services/phase-log/verbose-diagnostics-detector';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-vdd-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SELECTION = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1'
} as const;

async function makePhaseDir(): Promise<void> {
  await fs.mkdir(
    path.join(tmpDir, '.schegent', 'sessions', 'run-1', 'diagnostics', 'pipe-1', 'phase-1'),
    { recursive: true }
  );
}

describe('Feature 020 T017 — detectVerboseDiagnosticsState', () => {
  it('returns enabled-with-sessions when setting=true AND phase dir exists', async () => {
    await makePhaseDir();
    const banner = await detectVerboseDiagnosticsState({
      workspaceRoot: tmpDir,
      selection: SELECTION,
      readSetting: () => true
    });
    expect(banner).toEqual({ kind: 'enabled-with-sessions' });
  });

  it('returns enabled-no-sessions-for-tuple when setting=true AND phase dir missing', async () => {
    const banner = await detectVerboseDiagnosticsState({
      workspaceRoot: tmpDir,
      selection: SELECTION,
      readSetting: () => true
    });
    expect(banner).toEqual({ kind: 'enabled-no-sessions-for-tuple' });
  });

  it('returns disabled-no-sessions with settingKey when setting=false AND phase dir missing', async () => {
    const banner = await detectVerboseDiagnosticsState({
      workspaceRoot: tmpDir,
      selection: SELECTION,
      readSetting: () => false
    });
    expect(banner).toEqual({
      kind: 'disabled-no-sessions',
      settingKey: 'schegent.logging.verbose'
    });
  });

  it('returns enabled-with-sessions when setting=false but historical phase dir still exists', async () => {
    // Operator toggled the setting off but kept old runs on disk.
    await makePhaseDir();
    const banner = await detectVerboseDiagnosticsState({
      workspaceRoot: tmpDir,
      selection: SELECTION,
      readSetting: () => false
    });
    expect(banner).toEqual({ kind: 'enabled-with-sessions' });
  });
});
