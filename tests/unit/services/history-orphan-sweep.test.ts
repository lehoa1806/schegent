import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_DESCRIPTION_DIR,
  HISTORY_ORPHAN_GRACE_MS,
  HistoryDescriptionStore,
  runIdFromDescriptionFile
} from '../../../src/services/history/history-description-store';
import { sweepHistoryDescriptions } from '../../../src/services/history/history-description-sweep';
import { ensureHistoryEntry } from '../../../src/state/history-entry';

/**
 * FR-R3-111 (FR-115, FR-116, FR-118) — the sweep this store's own docstring cited for months.
 *
 * THE GAP. `read()` distinguishes "the retention sweep removed the file" from a refused reference
 * and an I/O failure — a good distinction, and the sweep it named **did not cover this
 * directory**. `SessionArtifactRetentionService` walks `.schegent/sessions/`, not
 * `.schegent/history/`. Eviction-edge removal exists in `history-recorder.ts`, is best-effort, and
 * swallows its failures, so any removal that failed left a file nothing would ever look at again.
 * Each orphan is up to 32,000 characters of operator-authored text, kept forever, referenced by
 * nothing.
 *
 * THE GRACE PERIOD IS THE LOAD-BEARING PART. A description is written BEFORE its history entry is
 * persisted, so an unreferenced file may simply be mid-write. A sweep on absence alone would
 * delete the description of the run that is starting.
 */
const dirs: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'history-sweep-'));
  dirs.push(root);
  mkdirSync(join(root, HISTORY_DESCRIPTION_DIR), { recursive: true });
  return root;
}

function writeDescription(root: string, runId: string, ageMs = 0): void {
  const file = join(root, HISTORY_DESCRIPTION_DIR, `${runId}.txt`);
  writeFileSync(file, 'operator-authored description text');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
}

const listing = (root: string): readonly string[] =>
  readdirSync(join(root, HISTORY_DESCRIPTION_DIR)).sort();

const store = (root: string): HistoryDescriptionStore =>
  new HistoryDescriptionStore({ workspaceRoot: root, logger: { warn: () => {} } });

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('FR-R3-111 — orphaned history descriptions are swept, bounded', () => {
  it('sweeps an old orphan, and counts it', async () => {
    const root = workspace();
    writeDescription(root, 'run-orphan', HISTORY_ORPHAN_GRACE_MS + 60_000);
    const result = await store(root).reconcile({ referenced: new Set(), nowMs: Date.now() });
    expect(result.swept).toBe(1);
    expect(listing(root)).toEqual([]);
  });

  it('a referenced description survives, however old', async () => {
    // The other direction. A live entry's file must not be swept on age alone — age is not the
    // criterion, being unreferenced is.
    const root = workspace();
    writeDescription(root, 'run-live', HISTORY_ORPHAN_GRACE_MS * 100);
    const result = await store(root).reconcile({
      referenced: new Set(['run-live']),
      nowMs: Date.now()
    });
    expect(result.swept).toBe(0);
    expect(listing(root)).toEqual(['run-live.txt']);
  });

  it('a YOUNG orphan survives, because it may be mid-write', async () => {
    // The case that makes a naive sweep destructive: the description is written before its entry
    // is persisted, so the run starting right now has an unreferenced file.
    const root = workspace();
    writeDescription(root, 'run-starting');
    const result = await store(root).reconcile({ referenced: new Set(), nowMs: Date.now() });
    expect(result.swept).toBe(0);
    expect(result.skippedYoung).toBe(1);
    expect(listing(root)).toEqual(['run-starting.txt']);
  });

  it('is bounded per activation, and leaves the backlog for the next one', async () => {
    const root = workspace();
    for (let i = 0; i < 12; i++) {
      writeDescription(root, `run-old-${i}`, HISTORY_ORPHAN_GRACE_MS + 60_000);
    }
    const result = await store(root).reconcile({
      referenced: new Set(),
      nowMs: Date.now(),
      maxRemovals: 5
    });
    expect(result.swept, 'the cap must hold').toBe(5);
    expect(listing(root).length, 'the rest wait for the next activation').toBe(7);
  });

  it('leaves files it did not write alone', async () => {
    // A sweep that deleted unrecognised files could delete anything someone put in that
    // directory. The filename parser is as strict as the writer.
    const root = workspace();
    writeFileSync(join(root, HISTORY_DESCRIPTION_DIR, 'notes.md'), 'someone put this here');
    const result = await store(root).reconcile({ referenced: new Set(), nowMs: Date.now() });
    expect(result.swept).toBe(0);
    expect(listing(root)).toEqual(['notes.md']);
  });

  it('an absent directory is not an error — every fresh workspace has none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'history-sweep-empty-'));
    dirs.push(root);
    const result = await store(root).reconcile({ referenced: new Set(), nowMs: Date.now() });
    expect(result).toEqual({ examined: 0, swept: 0, skippedYoung: 0 });
  });

  it('the filename parser is the exact inverse of the reference writer', () => {
    expect(runIdFromDescriptionFile('run-1.txt')).toBe('run-1');
    expect(runIdFromDescriptionFile('notes.md')).toBeNull();
    expect(runIdFromDescriptionFile('.txt')).toBeNull();
    expect(runIdFromDescriptionFile('../escape.txt')).toBeNull();
    expect(runIdFromDescriptionFile('run with spaces.txt')).toBeNull();
  });

  it('NON-VACUITY: the grace period is what saves the young orphan', () => {
    // Pins that the grace is the mechanism, rather than something incidental about the fixture.
    expect(0 < HISTORY_ORPHAN_GRACE_MS, 'a just-written file is inside the grace').toBe(true);
    expect(HISTORY_ORPHAN_GRACE_MS + 1 < HISTORY_ORPHAN_GRACE_MS).toBe(false);
  });
});

/**
 * FR-R4-F04 (G1) — the caller `reconcile` never had.
 *
 * `reconcile` above is correct, and until this feature only these tests called it: no production code did,
 * so the retention inventory's "removed once it is 24 hours old, at most 200 per activation" described a
 * sweep that never ran. `sweepHistoryDescriptions` is what the activation path calls. It adds the one
 * decision `reconcile` cannot make for itself, which descriptions are still referenced, and it reads that
 * from the RAW persisted rows: a row the history list would drop still protects its file, because keeping a
 * file is the safe way to be wrong here.
 */
describe('FR-R4-F04 (G1) — the activation sweep of history descriptions', () => {
  const OLD_MS = HISTORY_ORPHAN_GRACE_MS + 60_000;
  const quietLogger = () => ({ warn: vi.fn(), info: vi.fn() });
  const sweep = (
    root: string,
    historyMap: Readonly<Record<string, readonly object[]>>,
    logger = quietLogger()
  ) => sweepHistoryDescriptions({ workspaceRoot: root, logger, historyMap: () => historyMap, nowMs: Date.now() });

  it('removes an old description no row refers to, and reports the count', async () => {
    const root = workspace();
    writeDescription(root, 'run-orphan', OLD_MS);
    const result = await sweep(root, {});
    expect(result).toEqual({ examined: 1, swept: 1, skippedYoung: 0 });
    expect(listing(root)).toEqual([]);
  });

  it('keeps an old description that a row in ANY queue partition refers to', async () => {
    const root = workspace();
    writeDescription(root, 'run-in-a', OLD_MS);
    writeDescription(root, 'run-in-b', OLD_MS);
    writeDescription(root, 'run-orphan', OLD_MS);
    await sweep(root, {
      'queue-a': [{ runId: 'run-in-a', featureId: 'f' }],
      'queue-b': [{ runId: 'run-in-b', featureId: 'f' }]
    });
    expect(listing(root)).toEqual(['run-in-a.txt', 'run-in-b.txt']);
  });

  it('keeps a description a row names by descriptionRef alone, and one under the legacy id field', async () => {
    const root = workspace();
    writeDescription(root, 'run-by-ref', OLD_MS);
    writeDescription(root, 'run-legacy-id', OLD_MS);
    await sweep(root, {
      q: [{ descriptionRef: '.schegent/history/run-by-ref.txt' }, { id: 'run-legacy-id', featureId: 'f' }]
    });
    expect(listing(root)).toEqual(['run-by-ref.txt', 'run-legacy-id.txt']);
  });

  it('reads the RAW rows: a row the history list would drop still protects its file', async () => {
    const dropped = { runId: 'run-dropped' };
    // The control that makes this test mean something: the normaliser really does refuse this row, so a
    // referenced set built from the normalised list would have swept the file.
    expect(ensureHistoryEntry(dropped, 'q'), 'the fixture must be a row the list drops').toBeNull();
    const root = workspace();
    writeDescription(root, 'run-dropped', OLD_MS);
    await sweep(root, { q: [dropped] });
    expect(listing(root)).toEqual(['run-dropped.txt']);
  });

  it('keeps a young orphan, which may be mid-write, and counts it', async () => {
    const root = workspace();
    writeDescription(root, 'run-starting');
    const result = await sweep(root, {});
    expect(result).toEqual({ examined: 1, swept: 0, skippedYoung: 1 });
    expect(listing(root)).toEqual(['run-starting.txt']);
  });

  it('ignores malformed rows without failing, and still sweeps the real orphan', async () => {
    const root = workspace();
    writeDescription(root, 'run-orphan', OLD_MS);
    const malformed = [null, 7, 'text', {}, { runId: 42 }, { descriptionRef: 3 }] as unknown as readonly object[];
    const result = await sweep(root, { q: malformed });
    expect(result?.swept).toBe(1);
    expect(listing(root)).toEqual([]);
  });

  it('is fail-soft: an unreadable history map sweeps nothing, warns once, and names a code and no message', async () => {
    const root = workspace();
    writeDescription(root, 'run-orphan', OLD_MS);
    const logger = quietLogger();
    const failure = Object.assign(new Error('EIO: read failed at /Users/someone/secret-project/.schegent'), {
      code: 'EIO'
    });
    const result = await sweepHistoryDescriptions({
      workspaceRoot: root,
      logger,
      historyMap: () => {
        throw failure;
      },
      nowMs: Date.now()
    });
    expect(result, 'a sweep that could not tell what is referenced removes nothing').toBeNull();
    expect(listing(root)).toEqual(['run-orphan.txt']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('EIO');
    expect(logged, 'the thrown message names a path and is never logged').not.toContain('/Users/someone');
  });

  it('says how many it removed, as a count only', async () => {
    const root = workspace();
    writeDescription(root, 'run-orphan-1', OLD_MS);
    writeDescription(root, 'run-orphan-2', OLD_MS);
    const logger = quietLogger();
    await sweep(root, {}, logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = String(logger.info.mock.calls.at(0)?.at(0));
    expect(line).toContain('2');
    expect(line).not.toContain('run-orphan');
    // Nothing removed, nothing said: a quiet activation stays quiet.
    const quiet = quietLogger();
    await sweep(root, {}, quiet);
    expect(quiet.info).not.toHaveBeenCalled();
  });
});
