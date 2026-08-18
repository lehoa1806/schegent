// Feature 020 T029 — compose path / discovery / parse / projection /
// truncation into a single manifest read. Sanitizes every body string
// at the IPC boundary (research.md §5). See
// specs/020-phase-level-logs/contracts/phase-log-service.md §6.

import * as fs from 'node:fs/promises';
import { discoverIterations } from './phase-log-iteration-discovery';
import { parseStreamJsonlBytes } from './phase-log-jsonl-parser';
import { projectStreamJsonlLine } from './phase-log-display-projector';
import { resolvePhaseDirPath, resolveStreamJsonlPath } from './phase-log-path';
// Feature 098 (PRIV-01) — the boundary scrub is shared with the live
// tail session so a reopened phase and a watched one redact identically.
import { sanitizeDisplayEntryBody } from './phase-log-sanitizer';
import { truncateDisplayEntryBody } from './phase-log-truncator';
import { detectVerboseDiagnosticsState } from './verbose-diagnostics-detector';
import type {
  IterationManifest,
  PhaseLogDisplayEntry,
  PhaseLogReadResult,
  PhaseLogSelection
} from './types';

interface ReadCaps {
  readonly perFieldBytes: number;
  readonly maxEntries: number;
}

interface ReadIterationManifestArgs {
  readonly workspaceRoot: string;
  readonly selection: Pick<
    PhaseLogSelection,
    'queueId' | 'taskId' | 'pipelineId' | 'phaseId' | 'iterationN'
  >;
  readonly isInFlight: boolean;
  readonly caps: ReadCaps;
  readonly sanitize: (s: string) => string;
  readonly readSetting?: () => boolean;
}

function validateSelectionFullyPopulated(
  selection: ReadIterationManifestArgs['selection']
): void {
  if (typeof selection.queueId !== 'string' || selection.queueId.length === 0) {
    throw new TypeError('selection.queueId must be a non-empty string');
  }
  if (typeof selection.taskId !== 'string' || selection.taskId.length === 0) {
    throw new TypeError('selection.taskId must be a non-empty string');
  }
  if (typeof selection.pipelineId !== 'string' || selection.pipelineId.length === 0) {
    throw new TypeError('selection.pipelineId must be a non-empty string');
  }
  if (typeof selection.phaseId !== 'string' || selection.phaseId.length === 0) {
    throw new TypeError('selection.phaseId must be a non-empty string');
  }
}

export async function readIterationManifest(
  args: ReadIterationManifestArgs
): Promise<IterationManifest> {
  validateSelectionFullyPopulated(args.selection);
  const phaseDir = resolvePhaseDirPath({
    workspaceRoot: args.workspaceRoot,
    runId: args.selection.taskId,
    pipelineId: args.selection.pipelineId,
    phaseId: args.selection.phaseId
  });
  const iterations = await discoverIterations(phaseDir);
  const verboseDiagnosticsState = await detectVerboseDiagnosticsState({
    workspaceRoot: args.workspaceRoot,
    selection: args.selection,
    readSetting: args.readSetting ?? (() => false)
  });

  if (iterations.length === 0) {
    return {
      iterations: [],
      selectedIteration: null,
      entries: [],
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState,
      isInFlight: args.isInFlight
    };
  }

  const requested = args.selection.iterationN;
  const selectedIteration =
    typeof requested === 'number' && iterations.includes(requested)
      ? requested
      : iterations[0];

  const streamPath = resolveStreamJsonlPath({
    workspaceRoot: args.workspaceRoot,
    runId: args.selection.taskId,
    pipelineId: args.selection.pipelineId,
    phaseId: args.selection.phaseId,
    iterationN: selectedIteration
  });

  let bytes = '';
  try {
    bytes = await fs.readFile(streamPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Race: iteration discovered then file deleted between calls.
      return {
        iterations,
        selectedIteration,
        entries: [],
        skippedLines: 0,
        truncatedCount: 0,
        verboseDiagnosticsState,
        isInFlight: args.isInFlight
      };
    }
    throw err;
  }

  const { parsedLines, skippedLines } = parseStreamJsonlBytes(bytes, '');

  let entries: PhaseLogDisplayEntry[] = [];
  let truncatedCount = 0;
  for (const parsed of parsedLines) {
    const projected = projectStreamJsonlLine(parsed);
    if (!projected) continue;
    const truncated = truncateDisplayEntryBody(projected, {
      perFieldBytes: args.caps.perFieldBytes
    });
    if (truncated.bodyTruncated !== null) truncatedCount += 1;
    const sanitized = sanitizeDisplayEntryBody(truncated, args.sanitize);
    entries.push(sanitized);
  }

  if (entries.length > args.caps.maxEntries) {
    const retainedEntryCount = Math.max(0, args.caps.maxEntries - 1);
    const droppedEntryCount = entries.length - retainedEntryCount;
    const tail = retainedEntryCount > 0
      ? entries.slice(-retainedEntryCount)
      : [];
    const head: PhaseLogDisplayEntry = {
      seq: 0,
      kind: 'truncated-head',
      ts: null,
      body: { droppedEntryCount },
      bodyTruncated: null
    };
    entries = [head, ...tail];
  }

  entries = entries.map((entry, idx) => ({ ...entry, seq: idx }));

  return {
    iterations,
    selectedIteration,
    entries,
    skippedLines,
    truncatedCount,
    verboseDiagnosticsState,
    isInFlight: args.isInFlight
  };
}

export async function readPhaseLog(
  args: ReadIterationManifestArgs
): Promise<PhaseLogReadResult> {
  try {
    const manifest = await readIterationManifest(args);
    return { outcome: 'success', manifest };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { outcome: 'failure', reason: 'permission-denied' };
    }
    return { outcome: 'failure', reason: 'internal-error' };
  }
}
