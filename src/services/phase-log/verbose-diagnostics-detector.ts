// Feature 020 T028 — derive the verbose-diagnostics banner state from
// the setting × phase-dir existence permutations. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §8.

import * as fs from 'node:fs/promises';
import { resolvePhaseDirPath } from './phase-log-path';
import type { PhaseLogSelection, VerboseDiagnosticsBanner } from './types';

interface DetectArgs {
  readonly workspaceRoot: string;
  readonly selection: Pick<
    PhaseLogSelection,
    'queueId' | 'taskId' | 'pipelineId' | 'phaseId'
  >;
  readonly readSetting: () => boolean;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    if (code === 'EACCES' || code === 'EPERM') return false;
    throw err;
  }
}

export async function detectVerboseDiagnosticsState(
  args: DetectArgs
): Promise<VerboseDiagnosticsBanner> {
  const phaseDir = resolvePhaseDirPath({
    workspaceRoot: args.workspaceRoot,
    runId: args.selection.taskId,
    pipelineId: args.selection.pipelineId,
    phaseId: args.selection.phaseId
  });
  const exists = await dirExists(phaseDir);
  const settingOn = args.readSetting() === true;
  if (exists) {
    // Either the setting is on AND we have data, OR the operator
    // toggled the setting off but kept old runs. In both cases the
    // banner is suppressed.
    return { kind: 'enabled-with-sessions' };
  }
  if (settingOn) {
    return { kind: 'enabled-no-sessions-for-tuple' };
  }
  return {
    kind: 'disabled-no-sessions',
    settingKey: 'schegent.logging.verbose'
  };
}
