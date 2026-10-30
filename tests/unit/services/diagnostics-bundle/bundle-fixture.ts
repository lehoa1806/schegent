// Feature 251 (FR-R4-F04, contracts T23 and T24) — one workspace both diagnostics-bundle test files build on.
//
// Two Runs live in it: the SELECTED one and a SIBLING. Each has an audit row, runtime-log lines carrying its
// Run id, a failure record, a raw transcript, a transport file and a verbose diagnostic file. The runtime
// log is over 3 MiB of the selected Run's own lines, so the item share bites, and holds an OLDEST marker
// (which the front cut must remove) and a NEWEST one (which it must keep). Secrets are synthetic and are
// planted where a bundle must redact them: in runtime-log lines written straight to the file (no logger
// redacted them), in the raw files, and in the host settings.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';

import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { createFailureRecorder } from '../../../../src/services/failure-record/failure-record-service';
import type { BundleSources } from '../../../../src/services/diagnostics-bundle/bundle-collect';
import { removeTempRoot } from '../../../temp-root-cleanup';

export const SELECTED_RUN = '5b8a1c22-7d3e-4f10-9c44-1a2b3c4d5e6f';
export const SIBLING_RUN = '9e0f6a11-2b3c-4d55-8e66-7a8b9c0d1e2f';

export const MARKERS = {
  oldestLog: 'SYNTHETIC-MARKER-251-OLDEST-LOG',
  newestLog: 'SYNTHETIC-MARKER-251-NEWEST-LOG',
  sibling: 'SYNTHETIC-MARKER-251-SIBLING',
  failureSelected: 'SYNTHETIC-MARKER-251-FAILURE-SELECTED',
  rawTranscript: 'SYNTHETIC-MARKER-251-RAW-TRANSCRIPT',
  rawTransport: 'SYNTHETIC-MARKER-251-RAW-TRANSPORT',
  rawVerbose: 'SYNTHETIC-MARKER-251-RAW-VERBOSE'
} as const;

/** Secret-shaped strings the host's redaction set recognises. None is a real credential. */
export const SECRETS = {
  anthropic: 'sk-ant-api03_abcdefghijklmnopqrstuvwxyz12345',
  bearer: 'Bearer abcdefghijklmnopqrstuvwx123'
} as const;

export interface BundleFixture {
  readonly workspaceRoot: string;
  readonly sources: BundleSources;
  readonly rawFiles: readonly string[];
  readonly destinationDirectory: string;
  cleanup(): Promise<void>;
}

const LOG_LINE_FILLER = 'x'.repeat(96);
const SELECTED_LOG_LINES = 32_000;

/** `[ts] INFO message {"runId":...,"phase":...}`: the line shape a Run-path logger writes. */
function runLogLine(runId: string, message: string): string {
  return `[2026-10-31T00:00:00.000Z] INFO ${message} {"runId":"${runId}","phase":"speckit-plan"}`;
}

export async function buildBundleFixture(): Promise<BundleFixture> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-251-'));
  const workspaceRoot = path.join(scratch, 'workspace');
  const destinationDirectory = path.join(scratch, 'destination');
  await fs.mkdir(path.join(workspaceRoot, '.schegent', 'sessions'), { recursive: true });
  await fs.mkdir(destinationDirectory, { recursive: true });
  const logger = new SanitizedLogger([]);

  // Audit rows for both Runs, through the real writer. The non-count payload key is what the counts-only
  // allowlist must drop, so the synthetic secret in it can never reach a bundle.
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  for (const runId of [SELECTED_RUN, SIBLING_RUN]) {
    await audit.append({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'cli-invocation',
      outcome: 'info',
      payload: { durationMs: 1200, note: `${MARKERS.sibling} ${SECRETS.anthropic}` }
    });
  }

  // Failure records for both Runs, through the real recorder.
  const recorder = createFailureRecorder({
    logger: { warn: vi.fn(), sanitize: (value: string) => logger.sanitize(value) },
    queue: { queueIdForExistingTask: () => 'default' },
    workspaceRoot,
    platform: 'linux'
  });
  for (const [runId, summary] of [
    [SELECTED_RUN, MARKERS.failureSelected],
    [SIBLING_RUN, MARKERS.sibling]
  ] as const) {
    await recorder.record({
      run: { id: runId, featureId: 'task-1', currentPhase: 'implement' },
      cause: 'last_phase_issues_remain',
      result: { kind: 'remaining_issues', issues: [{ tag: 'regression', summary }], auditEntry: null },
      iteration: 1,
      iterationCap: 3
    } as Parameters<typeof recorder.record>[0]);
  }

  // The runtime log: the selected Run's lines (over 3 MiB, an OLDEST marker first and a NEWEST one last),
  // the sibling's, and host lines with no context. Written straight to the file, so nothing was redacted.
  const logLines: string[] = [runLogLine(SELECTED_RUN, `${MARKERS.oldestLog} ${SECRETS.bearer}`)];
  for (let n = 0; n < SELECTED_LOG_LINES; n += 1) {
    logLines.push(runLogLine(SELECTED_RUN, `step ${n} ${LOG_LINE_FILLER}`));
    if (n % 1000 === 0) {
      logLines.push(runLogLine(SIBLING_RUN, `${MARKERS.sibling} sibling line ${n}`));
      logLines.push(`[2026-10-31T00:00:00.000Z] INFO activation: ready ${workspaceRoot}`);
    }
  }
  logLines.push(runLogLine(SELECTED_RUN, `${MARKERS.newestLog} ${SECRETS.anthropic}`));
  const logPath = path.join(workspaceRoot, '.schegent', 'syslog');
  await fs.writeFile(logPath, `${logLines.join('\n')}\n`);

  // Raw files, for both Runs: the selected Run's carry the raw markers and a secret, the sibling's carry its own.
  const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
  const rawFiles: string[] = [];
  const write = async (target: string, content: string): Promise<void> => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    rawFiles.push(target);
  };
  await write(path.join(sessions, `raw-${SELECTED_RUN}.log`), `${MARKERS.rawTranscript} ${SECRETS.anthropic}\n`);
  await write(path.join(sessions, SELECTED_RUN, 'transport.log'), `${MARKERS.rawTransport}\t${SECRETS.bearer}\n`);
  await write(
    path.join(sessions, SELECTED_RUN, 'diagnostics', 'pipe', 'phase', 'iter-1', 'stream.jsonl'),
    `{"marker":"${MARKERS.rawVerbose}","cwd":"${workspaceRoot}"}\n`
  );
  await write(path.join(sessions, `raw-${SIBLING_RUN}.log`), `${MARKERS.sibling} sibling transcript\n`);
  await write(path.join(sessions, SIBLING_RUN, 'transport.log'), `${MARKERS.sibling}\tsibling transport\n`);

  const sources: BundleSources = {
    workspaceRoot,
    sanitize: (text) => logger.sanitize(text),
    sanitizeRecord: (record) => logger.sanitizeRecord(record),
    hostVersion: '0.2.0',
    hostSettings: () => ({
      'logging.sessionRetentionMaxAgeDays': 30,
      'backend.apiKey': SECRETS.anthropic,
      // One path outside the workspace (a bundle must say `[path]`) and one inside it (it must read relative).
      'logging.runtimeLogFilePath': '/srv/elsewhere/syslog',
      'workspace.notes': path.join(workspaceRoot, 'notes.md')
    }),
    runStatus: (runId) =>
      runId === SELECTED_RUN
        ? { status: 'failed', currentPhase: 'speckit-plan', failureCause: 'cap_exhausted', phasesCompleted: 2 }
        : null,
    runtimeLog: () => ({ path: logPath, maxGenerations: 3 }),
    platform: 'linux'
  };

  return {
    workspaceRoot,
    sources,
    rawFiles,
    destinationDirectory,
    cleanup: async () => {
      await removeTempRoot(scratch);
    }
  };
}
