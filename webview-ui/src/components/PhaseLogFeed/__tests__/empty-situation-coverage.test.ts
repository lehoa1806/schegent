// Feature 203 T005 — the reachability harness for the five empty situations.
//
// FR-025 / SC-001 / SC-006 / F10. The claim under test is that four of the
// five reachable empty situations render NO CARD AT ALL, and that claim is a
// DERIVED HYPOTHESIS until this file runs. It is derived from reading the
// classifier, and reading is exactly the kind of evidence this feature exists
// to stop trusting.
//
// So nothing here is hand-copied from what the host is believed to produce.
// Each situation is built as a real directory tree on disk, the REAL host
// `readIterationManifest` runs against it, and the manifest that comes back is
// handed to a REAL render of `PhaseLogFeed` through the store's read seam. The
// zero-card count is therefore measured end to end rather than asserted from a
// reading of `showEmptyCard`.
//
// A webview test may value-import a host module: `webview-host-import-
// direction.test.ts:120` exempts `__tests__|\.test\.ts$` from the ban, which
// governs production import direction. Nothing under `src/services/phase-log/`
// imports `vscode`, so the reader runs unmodified under the jsdom environment.
//
// ORDERING (tasks.md T006, absolute): this file is run against the UNCORRECTED
// tree first and the number of situations rendering zero cards is recorded.
// After the Phase 4 correction that number is unobtainable — the tree that
// produced it no longer exists.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type {
  BackendRunnerKind,
  QueueItem,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import type {
  IterationManifest,
  PhaseLogReadResult,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from '../../../../../src/services/phase-log/types';
import { readIterationManifest } from '../../../../../src/services/phase-log/phase-log-reader';

// --- module mocks ------------------------------------------------------

// The feed imports `readPhaseLog` directly for its cold-start probe. The probe
// is unreachable here (`queue.recent` is empty), but the module is mocked so a
// future change cannot make this harness talk to a real extension host.
const startSpy = vi.fn<(req: unknown) => Promise<PhaseLogTailStartResult>>();
const stopSpy = vi.fn<(req: unknown) => Promise<PhaseLogTailStopResult>>();
const readSpy = vi.fn<(req: unknown) => Promise<PhaseLogReadResult>>();

vi.mock('../../../lib/phase-log-ipc', () => ({
  readPhaseLog: (req: unknown) => readSpy(req),
  startPhaseLogTail: (req: unknown) => startSpy(req),
  stopPhaseLogTail: (req: unknown) => stopSpy(req),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: () => () => {}
}));

vi.mock('../../../lib/vscode-api', () => ({
  postCommand: () => {},
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

// Late imports, after the mocks above.
import PhaseLogFeed from '../PhaseLogFeed.svelte';
import { createPhaseLogStore } from '../../../lib/phase-log-store.svelte';

// --- the tuple every situation is addressed by --------------------------

const QUEUE_ID = 'q-1';
const TASK_ID = 'run-1';
const PIPELINE_ID = 'standard';
const PHASE_ID = 'speckit-plan';

const SELECTION = {
  queueId: QUEUE_ID,
  taskId: TASK_ID,
  pipelineId: PIPELINE_ID,
  phaseId: PHASE_ID,
  iterationN: null as number | null
};

const CAPS = { perFieldBytes: 4096, maxEntries: 500 };

// A projectable line, matching the fixture shape the host reader's own test
// uses (`tests/unit/services/phase-log/phase-log-reader.test.ts:69`).
const PROJECTABLE_LINE = '{"type":"system","subtype":"init"}\n';

// --- on-disk situation construction -------------------------------------

let scratchRoot: string;

function phaseDirOf(workspaceRoot: string): string {
  return nodePath.join(
    workspaceRoot,
    '.schegent',
    'sessions',
    TASK_ID,
    'diagnostics',
    PIPELINE_ID,
    PHASE_ID
  );
}

/**
 * A fresh workspace root per situation, outside both git trees. Each situation
 * owns its own tree so one cannot leave residue in another.
 */
async function newWorkspace(name: string): Promise<string> {
  const root = nodePath.join(scratchRoot, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** Situation 1 — no record directory at all. */
async function buildNoRecordDirectory(): Promise<string> {
  return newWorkspace('s1-no-record-directory');
}

/** Situation 2 — the record directory exists and holds no iteration. */
async function buildNoIteration(): Promise<string> {
  const root = await newWorkspace('s2-no-iteration');
  await fs.mkdir(phaseDirOf(root), { recursive: true });
  return root;
}

/** Situation 3 — an iteration whose stream file is not there. */
async function buildStreamMissing(): Promise<string> {
  const root = await newWorkspace('s3-stream-missing');
  await fs.mkdir(nodePath.join(phaseDirOf(root), 'iter-1'), { recursive: true });
  return root;
}

/**
 * Situation 4 — the stream path is not a readable regular file.
 *
 * Built as a DIRECTORY rather than by `chmod 000`: a directory is refused
 * identically for every user, where a mode-based refusal silently succeeds for
 * root and proves nothing. The permission variant has its own baseline in T008.
 */
async function buildStreamNotARegularFile(): Promise<string> {
  const root = await newWorkspace('s4-stream-not-a-regular-file');
  await fs.mkdir(nodePath.join(phaseDirOf(root), 'iter-1', 'stream.jsonl'), {
    recursive: true
  });
  return root;
}

/** Situation 5 — the stream reads, and yields no displayable line. */
async function buildNoDisplayableLine(): Promise<string> {
  const root = await newWorkspace('s5-no-displayable-line');
  const iterDir = nodePath.join(phaseDirOf(root), 'iter-1');
  await fs.mkdir(iterDir, { recursive: true });
  await fs.writeFile(nodePath.join(iterDir, 'stream.jsonl'), '', 'utf8');
  return root;
}

/** The control — a stream that does yield a displayable line. */
async function buildEntriesPresent(): Promise<string> {
  const root = await newWorkspace('c1-entries-present');
  const iterDir = nodePath.join(phaseDirOf(root), 'iter-1');
  await fs.mkdir(iterDir, { recursive: true });
  await fs.writeFile(nodePath.join(iterDir, 'stream.jsonl'), PROJECTABLE_LINE, 'utf8');
  return root;
}

/**
 * The manifest the CURRENT host produces for a situation. The operator setting
 * is ON throughout: an operator who has turned diagnostics on and is looking at
 * a blank pane is the situation the feature is about, and it is also the harder
 * case — with the setting off, situation 1 would take a different branch.
 */
async function manifestFor(workspaceRoot: string): Promise<IterationManifest> {
  return readIterationManifest({
    workspaceRoot,
    selection: SELECTION,
    isInFlight: false,
    // T031 made this required. `not-running` is the faithful continuation of
    // the T006 baseline: the tree that produced that count had no progress
    // concept at all, so nothing in it could claim a phase was still running.
    // Every situation below is therefore compared against the same tree state
    // it was measured against, with the running variants left to T039.
    progress: 'not-running',
    caps: CAPS,
    sanitize: (s: string) => s,
    readSetting: () => true
  });
}

// --- the render harness --------------------------------------------------

function buildSnapshot(): WorkflowSnapshot {
  // Minimal by intent. The card decision reads nothing from the snapshot — it
  // is derived entirely from store state — so every field here exists only to
  // let the component mount. `queue.inFlight` is null and `queue.recent` is
  // empty so the cold-start fallback returns at its own guard and no selection
  // is made except the one this harness makes.
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([]),
    queue: Object.freeze({
      orderedItems: Object.freeze([]) as readonly QueueItem[],
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      paused: false,
      queues: Object.freeze([
        Object.freeze({
          id: QUEUE_ID,
          name: 'Default',
          position: 0,
          state: 'active' as const,
          pauseSource: null,
          schedule: null,
          taskCount: 0,
          failurePolicy: 'halt-on-failure' as const,
          failurePolicyOverride: null
        })
      ])
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-09-05T12:00:00.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({
        id: PIPELINE_ID,
        name: 'Standard',
        phases: Object.freeze(['speckit-specify', PHASE_ID, 'speckit-tasks'])
      })
    ]),
    availablePhases: Object.freeze([
      Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '', loopable: false }),
      Object.freeze({ id: PHASE_ID, name: 'Plan', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-tasks', name: 'Tasks', instruction: '', loopable: false })
    ]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<
      BackendRunnerKind,
      readonly string[]
    >,
    availableBackends: Object.freeze(['claude']) as readonly BackendRunnerKind[]
  } as unknown as WorkflowSnapshot);
}

interface RenderOutcome {
  readonly cardTestIds: readonly string[];
  readonly readingPanePresent: boolean;
}

/**
 * Renders the feed against a manifest and reports which empty cards appeared.
 *
 * Cards are found by the `phase-log-empty-` test-id prefix rather than by a
 * fixed list, so this harness does not have to be edited when the enumeration
 * grows from three cards to seven. Buttons carrying the same prefix (the
 * "Open Settings" CTA at `PhaseLogEmptyStates.svelte`) are excluded: a control
 * inside a card is not a second card.
 */
async function renderWithManifest(manifest: IterationManifest): Promise<RenderOutcome> {
  const result: PhaseLogReadResult = { outcome: 'success', manifest };
  const store = createPhaseLogStore(
    () => Promise.resolve(result),
    {
      start: (req) => startSpy(req),
      stop: (req) => stopSpy(req),
      subscribe: () => () => {}
    }
  );
  const { container } = render(PhaseLogFeed, {
    props: { snapshot: buildSnapshot(), store }
  });

  store.setSelection({
    queueId: QUEUE_ID,
    taskId: TASK_ID,
    pipelineId: PIPELINE_ID,
    phaseId: PHASE_ID,
    iterationN: null
  });
  // Same drain as `PhaseLogFeed.test.ts`: read → state patch → derived
  // re-evaluation → effect scheduling.
  await tick();
  await tick();
  await tick();
  await tick();

  const cardTestIds = Array.from(
    container.querySelectorAll('[data-testid^="phase-log-empty-"]')
  )
    .filter((el) => el.tagName !== 'BUTTON')
    .map((el) => el.getAttribute('data-testid') ?? '');

  return {
    cardTestIds,
    readingPanePresent:
      container.querySelector('[data-testid="phase-log-entry-list"]') !== null
  };
}

beforeAll(async () => {
  scratchRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'schegent-203-empty-'));
});

afterAll(async () => {
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
  readSpy.mockReset();
  startSpy.mockReset();
  stopSpy.mockReset();
});

describe('Feature 203 T005 — every reachable empty situation reaches the operator', () => {
  // The non-vacuity floor for this harness. If the render never mounts, or the
  // store never applies the manifest, all five situations below would report
  // zero cards and read exactly like the defect. This case fails first and
  // says so.
  it('control: entries present renders the reading pane and no empty card', async () => {
    const manifest = await manifestFor(await buildEntriesPresent());
    expect(manifest.entries.length).toBeGreaterThan(0);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.readingPanePresent).toBe(true);
    expect(outcome.cardTestIds).toEqual([]);
  });

  it('situation 1 — no record directory', async () => {
    const manifest = await manifestFor(await buildNoRecordDirectory());
    expect(manifest.entries).toEqual([]);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.cardTestIds.length).toBeGreaterThan(0);
  });

  it('situation 2 — record directory with no iteration', async () => {
    const manifest = await manifestFor(await buildNoIteration());
    expect(manifest.entries).toEqual([]);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.cardTestIds.length).toBeGreaterThan(0);
  });

  it('situation 3 — iteration whose stream is missing', async () => {
    const manifest = await manifestFor(await buildStreamMissing());
    expect(manifest.entries).toEqual([]);
    expect(manifest.iterations).toEqual([1]);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.cardTestIds.length).toBeGreaterThan(0);
  });

  it('situation 4 — iteration whose stream is not a readable regular file', async () => {
    const manifest = await manifestFor(await buildStreamNotARegularFile());
    expect(manifest.entries).toEqual([]);
    expect(manifest.iterations).toEqual([1]);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.cardTestIds.length).toBeGreaterThan(0);
  });

  it('situation 5 — stream read yielding no displayable line', async () => {
    const manifest = await manifestFor(await buildNoDisplayableLine());
    expect(manifest.entries).toEqual([]);
    expect(manifest.iterations).toEqual([1]);
    const outcome = await renderWithManifest(manifest);
    expect(outcome.cardTestIds.length).toBeGreaterThan(0);
  });
});
