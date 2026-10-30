// Feature 251 (FR-R4-F04, T2 to T5) — the harness the transport tests share: the REAL sink over the
// REAL router and store, over real temporary directories.
//
// WHY A HARNESS AND NOT DOUBLES. Every claim these tests make is about bytes on disk: that a marker
// is in no file under `off`, that the clean Run's marker is not retained, that an expired record is
// gone. A router or store double would answer "contained" and "written" unconditionally and make each
// of those assertions vacuous while looking green (the argument `cli-transport-sink.test.ts` makes for
// its own real tree). The OS temp root a test hands the router is a temporary directory, never the
// real `os.tmpdir()`, so a stage a test leaves behind cannot leak into the machine's temp area.
//
// Wall time is the caller's: a test fakes `Date` with `vi.useFakeTimers({ toFake: ['Date'] })` and the
// sink and router read it per record.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCliTransportSink, type CliTransportSink } from '../../../../src/monitor/cli-transport-sink';
import { createTransportRouter, type TransportRouter } from '../../../../src/monitor/transport/transport-router';
import { TRANSPORT_RUN_FILE_NAME, TRANSPORT_SPOOL_PREFIX } from '../../../../src/monitor/transport/transport-policy';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { RawTranscriptMode, WorkflowRunStatus } from '../../../../src/state/workflow-run';
import { removeTempRoot } from '../../../temp-root-cleanup';

const realLogger = new SanitizedLogger([]);

/** What a test sets between records: the settings the router reads uncached, and the Run statuses. */
export interface TransportHarness {
  /** The workspace the sink writes under. */
  readonly workspaceRoot: string;
  /** The stand-in for the OS temp root; the stage lives beneath it. */
  readonly tempRoot: string;
  readonly warnings: string[];
  setting: unknown;
  rawMode: RawTranscriptMode;
  ageDays: number;
  readonly statuses: Map<string, WorkflowRunStatus>;
  readonly router: TransportRouter;
  readonly sink: CliTransportSink;
  record(runId: string, line: string, options?: { phase?: string; stream?: 'stdout' | 'stderr' }): void;
  flush(): Promise<void>;
  /** A host restart: a new router and sink over the same directories. */
  restart(): Promise<void>;
  runFile(runId: string): string;
  /** The stage directory, or `null` when none exists under the temp root. */
  stageDirectory(): Promise<string | null>;
  stageFile(runId: string): Promise<string | null>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  readonly setting?: unknown;
  readonly rawMode?: RawTranscriptMode;
  readonly ageDays?: number;
}

/** The Run file's path, under a workspace. */
export function runFilePath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, '.schegent', 'sessions', runId, TRANSPORT_RUN_FILE_NAME);
}

export async function createTransportHarness(options: HarnessOptions = {}): Promise<TransportHarness> {
  // One scratch parent per harness, so a single cleanup removes the workspace and the temp stand-in.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-transport-251-'));
  const workspaceRoot = path.join(scratch, 'workspace');
  const tempRoot = path.join(scratch, 'os-temp');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };
  const state: {
    setting: unknown;
    rawMode: RawTranscriptMode;
    ageDays: number;
    statuses: Map<string, WorkflowRunStatus>;
  } = {
    setting: options.setting ?? 'on',
    rawMode: options.rawMode ?? 'errors-only',
    ageDays: options.ageDays ?? 30,
    statuses: new Map<string, WorkflowRunStatus>()
  };

  const build = (): { router: TransportRouter; sink: CliTransportSink } => {
    const router = createTransportRouter({
      workspaceRoot: () => workspaceRoot,
      readSetting: () => state.setting,
      readRawTranscriptMode: () => state.rawMode,
      readMaxAgeDays: () => state.ageDays,
      tempRoot,
      runStatus: (runId) => state.statuses.get(runId),
      logger
    });
    const sink = createCliTransportSink(router, {
      sanitize: (line) => realLogger.sanitize(line),
      warn: logger.warn
    });
    return { router, sink };
  };

  let current = build();
  const harness: TransportHarness = {
    workspaceRoot,
    tempRoot,
    warnings,
    get setting() {
      return state.setting;
    },
    set setting(value: unknown) {
      state.setting = value;
    },
    get rawMode() {
      return state.rawMode;
    },
    set rawMode(value: RawTranscriptMode) {
      state.rawMode = value;
    },
    get ageDays() {
      return state.ageDays;
    },
    set ageDays(value: number) {
      state.ageDays = value;
    },
    statuses: state.statuses,
    get router() {
      return current.router;
    },
    get sink() {
      return current.sink;
    },
    record: (runId, line, recordOptions) => {
      current.sink.record({
        runId,
        phase: recordOptions?.phase ?? 'speckit-implement',
        stream: recordOptions?.stream ?? 'stdout',
        line
      });
    },
    flush: () => current.sink.flushPendingWrites(),
    restart: async () => {
      await current.sink.flushAndDispose();
      current = build();
    },
    runFile: (runId) => runFilePath(workspaceRoot, runId),
    stageDirectory: async () => {
      const names = await fs.readdir(tempRoot);
      const found = names.find((name) => name.startsWith(TRANSPORT_SPOOL_PREFIX));
      return found === undefined ? null : path.join(tempRoot, found);
    },
    stageFile: async (runId) => {
      const directory = await harness.stageDirectory();
      if (directory === null) return null;
      const file = path.join(directory, `${runId}.log`);
      try {
        await fs.stat(file);
        return file;
      } catch {
        return null;
      }
    },
    dispose: async () => {
      await current.sink.flushAndDispose();
      await removeTempRoot(scratch);
    }
  };
  return harness;
}

/** Every file beneath `roots`, recursively. A root that does not exist contributes nothing. */
export async function listFilesUnder(...roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  for (const root of roots) await walk(root);
  return found.sort();
}

/** The files beneath `roots` whose bytes contain `marker`. A byte search, as SC-001 states it. */
export async function filesContaining(marker: string, ...roots: readonly string[]): Promise<string[]> {
  const needle = Buffer.from(marker, 'utf8');
  const hits: string[] = [];
  for (const file of await listFilesUnder(...roots)) {
    if ((await fs.readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}
