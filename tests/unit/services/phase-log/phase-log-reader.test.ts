// Feature 020 T018 — `readIterationManifest`: end-to-end fixture →
// manifest with sanitized + truncated entries; SECRET_PATTERNS
// redaction verified at the IPC body. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §6.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { readIterationManifest } from '../../../../src/services/phase-log/phase-log-reader';
import type { PhaseProgress } from '../../../../src/services/phase-log/types';

// Feature 203 (T038) — the ONLY seam in this file, and it exists for one return
// site. Three of the reader's four empty return sites are reachable by building
// the situation on disk, and are built that way below. The fourth is the race
// window: discovery listed `iter-N`, the open succeeded, and the stream then went
// away. Once the descriptor is open no filesystem state can produce an ENOENT
// through it, so on a POSIX filesystem that branch is unreachable from the public
// API — the arrangement, not the assertion, is what needs the seam.
//
// The MEMBER that branch returns is proven on disk independently, by the missing-
// leaf case below, which is why mocking here weakens nothing: what is being
// checked is that the second code path answers with the same member, per D2.
const race = vi.hoisted(() => ({ armed: false }));
vi.mock('../../../../src/lib/safe-open', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/safe-open')>();
  return {
    ...actual,
    openWithinRootByPath: async (
      ...args: Parameters<typeof actual.openWithinRootByPath>
    ): ReturnType<typeof actual.openWithinRootByPath> => {
      if (!race.armed) return actual.openWithinRootByPath(...args);
      race.armed = false;
      const vanished: NodeJS.ErrnoException = new Error('stream removed after listing');
      vanished.code = 'ENOENT';
      throw vanished;
    }
  };
});

let tmpDir: string;
const logger = new SanitizedLogger();

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-reader-'));
  // The seam disarms itself when it fires, so this matters only when the test
  // that armed it failed before reaching the read. Without it that failure
  // would travel into the next test as a second, unexplained one.
  race.armed = false;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const BASE_SELECTION = {
  queueId: 'q1',
  taskId: 'run-1',
  pipelineId: 'pipe-1',
  phaseId: 'phase-1',
  iterationN: null as number | null
};

function streamPath(iteration: number): string {
  return path.join(
    tmpDir,
    '.schegent',
    'sessions',
    'run-1',
    'diagnostics',
    'pipe-1',
    'phase-1',
    `iter-${iteration}`,
    'stream.jsonl'
  );
}

async function writeStream(iteration: number, lines: string[]): Promise<void> {
  const p = streamPath(iteration);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, lines.map((l) => `${l}\n`).join(''));
}

const sanitize = (s: string): string => logger.sanitize(s);

/** The phase directory itself — the one the single observation lists (D3). */
function phaseDirPath(): string {
  return path.join(tmpDir, '.schegent', 'sessions', 'run-1', 'diagnostics', 'pipe-1', 'phase-1');
}

/** An `iter-N` directory with no stream inside it, which is a listable record. */
async function makeIterationDir(iteration: number): Promise<string> {
  const dir = path.join(phaseDirPath(), `iter-${iteration}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('Feature 020 T018 — readIterationManifest end-to-end', () => {
  it('returns an empty manifest when the phase dir does not exist', async () => {
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.iterations).toEqual([]);
    expect(manifest.selectedIteration).toBeNull();
    expect(manifest.entries).toEqual([]);
    expect(manifest.skippedLines).toBe(0);
    expect(manifest.truncatedCount).toBe(0);
    expect(manifest.isInFlight).toBe(false);
  });

  it('discovers iterations descending and defaults selectedIteration to the latest', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    await writeStream(2, ['{"type":"system","subtype":"init"}']);
    await writeStream(5, ['{"type":"system","subtype":"init"}']);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.iterations).toEqual([5, 2, 1]);
    expect(manifest.selectedIteration).toBe(5);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it('honors a requested iterationN when in iterations[]', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    await writeStream(2, ['{"type":"system","subtype":"init"}']);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: { ...BASE_SELECTION, iterationN: 1 },
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.selectedIteration).toBe(1);
  });

  it('counts malformed lines into skippedLines', async () => {
    await writeStream(1, [
      '{"type":"system","subtype":"init"}',
      'this is not json',
      '{"type":"result","duration_ms":1}'
    ]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.skippedLines).toBe(1);
    expect(manifest.entries.length).toBe(2);
  });

  it('redacts SECRET_PATTERNS-matching strings in entry bodies', async () => {
    // Anthropic-style API key — matches SECRET_PATTERNS.
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `leaked: ${secret} :end` }]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'assistant-text');
    expect(entry).toBeDefined();
    expect(entry?.body.text).not.toContain(secret);
    expect(entry?.body.text).toContain('[REDACTED]');
  });

  it('truncates large bodies and counts them into truncatedCount', async () => {
    const big = 'x'.repeat(5000);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: big }] }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    expect(manifest.truncatedCount).toBe(1);
    const entry = manifest.entries[0];
    expect(entry.bodyTruncated?.text?.originalLength).toBe(5000);
  });

  it('caps entries at maxEntries and prepends a truncated-head synthetic entry', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `line-${i}` }] }
        })
      );
    }
    await writeStream(1, lines);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 10 },
      sanitize
    });
    expect(manifest.entries.length).toBe(10);
    expect(manifest.entries[0].kind).toBe('truncated-head');
    // Nine real entries fit beside the synthetic marker, so three were dropped.
    expect(manifest.entries[0].body.droppedEntryCount).toBe(3);
  });

  it('reports all rows dropped when the cap leaves room only for the marker', async () => {
    await writeStream(1, [
      '{"type":"system","subtype":"one"}',
      '{"type":"system","subtype":"two"}'
    ]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 1 },
      sanitize
    });

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        kind: 'truncated-head',
        body: { droppedEntryCount: 2 }
      })
    ]);
  });

  it('throws TypeError when the selection is not fully populated', async () => {
    await expect(
      readIterationManifest({
        workspaceRoot: tmpDir,
        // @ts-expect-error — testing invariant
        selection: { ...BASE_SELECTION, taskId: null },
        isInFlight: false,
        progress: 'not-running',
        caps: { perFieldBytes: 4096, maxEntries: 500 },
        sanitize
      })
    ).rejects.toThrow(TypeError);
  });
});

describe('Feature 029 — sanitizeToolArguments recursive string-leaf redaction', () => {
  it('redacts SECRET_PATTERNS tokens inside scalar string leaves of toolArguments', async () => {
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/x', token: `leaked: ${secret} :end` }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    expect(entry).toBeDefined();
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    // Keys must be untouched.
    expect(Object.keys(args ?? {})).toEqual(['file_path', 'token']);
    // String leaf containing the secret must be redacted.
    expect(args?.['token']).not.toContain(secret);
    expect(String(args?.['token'])).toContain('[REDACTED]');
    // Other string leaves pass through unchanged.
    expect(args?.['file_path']).toBe('/x');
  });

  it('does not sanitize object keys even if the key text matches a SECRET pattern', async () => {
    // Construct a key that happens to look like a token; sanitizeToolArguments
    // walks values only, never keys.
    const tokenLikeKey = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Custom',
            input: { [tokenLikeKey]: 'normal-value' }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    // Key preserved as-is (no redaction).
    expect(Object.keys(args ?? {})).toContain(tokenLikeKey);
    expect(args?.[tokenLikeKey]).toBe('normal-value');
  });

  it('redacts secrets inside nested objects and arrays under toolArguments', async () => {
    const secret = 'sk-ant-1234567890abcdef1234567890ABCDEF';
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Nested',
            input: {
              nested: {
                items: [`prefix ${secret} suffix`, 'clean']
              }
            }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as
      | { nested: { items: unknown[] } }
      | undefined;
    expect(args).toBeDefined();
    const items = args?.nested.items as string[];
    expect(items[0]).not.toContain(secret);
    expect(items[0]).toContain('[REDACTED]');
    expect(items[1]).toBe('clean');
  });

  it('passes non-string scalars through toolArguments unchanged', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Custom',
            input: {
              count: 42,
              ratio: 0.5,
              enabled: true,
              disabled: false,
              empty: null
            }
          }
        ]
      }
    });
    await writeStream(1, [line]);
    const manifest = await readIterationManifest({
      workspaceRoot: tmpDir,
      selection: BASE_SELECTION,
      isInFlight: false,
      progress: 'not-running',
      caps: { perFieldBytes: 4096, maxEntries: 500 },
      sanitize
    });
    const entry = manifest.entries.find((e) => e.kind === 'tool-use');
    const args = entry?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args).toEqual({
      count: 42,
      ratio: 0.5,
      enabled: true,
      disabled: false,
      empty: null
    });
  });
});

// ---------------------------------------------------------------------------
// Feature 203 — the reader says WHICH kind of nothing it found.
//
// Before this feature the four return sites below produced a byte-identical
// manifest for four different situations, and a separate classifier re-`stat`ed
// the phase directory afterwards to guess a label from directory existence
// alone. The cases here pin one member per site, so a site that quietly starts
// answering with a neighbour's member fails on the member's NAME rather than on
// a count that two disagreeing lists can both satisfy.
// ---------------------------------------------------------------------------

interface ReadOptions {
  readonly progress?: PhaseProgress;
  readonly settingOn?: boolean;
  readonly iterationN?: number | null;
  /** Task-level and independent of `progress` (X4); defaults to matching it. */
  readonly isInFlight?: boolean;
}

async function read(options: ReadOptions = {}) {
  const progress = options.progress ?? 'not-running';
  return readIterationManifest({
    workspaceRoot: tmpDir,
    selection: { ...BASE_SELECTION, iterationN: options.iterationN ?? null },
    isInFlight: options.isInFlight ?? progress === 'running',
    progress,
    caps: { perFieldBytes: 4096, maxEntries: 500 },
    sanitize,
    readSetting: () => options.settingOn ?? false
  });
}

describe('Feature 203 T038 — every reader return site labels its own situation', () => {
  it('site A: a phase never reached is phase-not-recorded', async () => {
    const manifest = await read({ settingOn: true });
    expect(manifest.iterations).toEqual([]);
    expect(manifest.entries).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-not-recorded' });
  });

  it('site A: a phase reached that recorded no iteration is no-iteration-recorded', async () => {
    await fs.mkdir(phaseDirPath(), { recursive: true });
    const manifest = await read({ settingOn: true });
    expect(manifest.iterations).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'no-iteration-recorded' });
  });

  it('site A: those two situations are distinguishable, which is the whole of D3', async () => {
    // The single observation now reports WHICH emptiness it found. Asserted by
    // NAME and in one run over the same tree, transitioned between reads: two
    // members that merely differ in count would satisfy an equality of counts.
    const absent = await read({ settingOn: true });
    await fs.mkdir(phaseDirPath(), { recursive: true });
    const empty = await read({ settingOn: true });
    expect(absent.verboseDiagnosticsState.kind).toBe('phase-not-recorded');
    expect(empty.verboseDiagnosticsState.kind).toBe('no-iteration-recorded');
    expect(absent.verboseDiagnosticsState.kind).not.toBe(empty.verboseDiagnosticsState.kind);
    // Both still return the same empty manifest, which is why the label had to
    // carry the distinction rather than the shape.
    expect(absent.entries).toEqual(empty.entries);
    expect(absent.iterations).toEqual(empty.iterations);
  });

  it('site B: an iteration whose stream never arrived is record-vanished', async () => {
    await makeIterationDir(1);
    const manifest = await read({ settingOn: true });
    // Unlike site A, this manifest KEEPS the discovered iterations: the record
    // exists, and the operator can select another one.
    expect(manifest.iterations).toEqual([1]);
    expect(manifest.selectedIteration).toBe(1);
    expect(manifest.entries).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'record-vanished' });
  });

  it('site B: a stream path that is not a readable regular file is record-path-refused', async () => {
    const dir = await makeIterationDir(1);
    const behindTheLink = path.join(dir, 'stream.jsonl.real');
    await fs.writeFile(behindTheLink, '{"type":"system","subtype":"init"}\n');
    try {
      await fs.symlink(behindTheLink, path.join(dir, 'stream.jsonl'));
    } catch (err) {
      // A stated skip, keyed on the CAPABILITY rather than on a platform name:
      // a filesystem that will not create the link cannot build this situation.
      // The production branch keys on "errno is not ENOENT" and names neither a
      // code nor a platform; this is the fixture, not the branch.
      console.info(
        `[phase-log-reader] symlink unavailable (${(err as NodeJS.ErrnoException).code}) — ` +
          'record-path-refused was not constructed in this run'
      );
      return;
    }
    const manifest = await read({ settingOn: true });
    expect(manifest.iterations).toEqual([1]);
    expect(manifest.entries).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'record-path-refused' });
    // The bytes ARE reachable through the link. The refusal is about the path,
    // and the member says so rather than reporting an empty log.
    expect(await fs.readFile(path.join(dir, 'stream.jsonl'), 'utf8')).toContain('init');
  });

  it('site C: a stream that went away between listing and open is record-vanished', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    race.armed = true;
    const manifest = await read({ settingOn: true });
    // Control for the seam. If the arrangement silently stopped applying, the
    // flag would still be armed and this case would be asserting the ordinary
    // read's member instead of the race branch's.
    expect(race.armed, 'the race seam did not fire; the branch below was not reached').toBe(false);
    expect(manifest.iterations).toEqual([1]);
    expect(manifest.entries).toEqual([]);
    // Deliberately the SAME member as the missing-leaf case above: two code
    // paths, one operator situation (D2, FR-003).
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'record-vanished' });
  });

  it('site D: a record that produced displayable entries is entries-present', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    const manifest = await read({ settingOn: true });
    expect(manifest.entries.length).toBe(1);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'entries-present' });
  });

  it('site D: a record whose every line was unreadable is nothing-displayable', async () => {
    await writeStream(1, ['this is not json']);
    const manifest = await read({ settingOn: true });
    expect(manifest.entries).toEqual([]);
    expect(manifest.skippedLines).toBe(1);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'nothing-displayable' });
  });

  it('carries the task-level flag through untouched, and never classifies from it', async () => {
    await writeStream(1, ['this is not json']);
    // A Task in flight whose PHASE is not the running one. Classifying from the
    // task-level flag would promise output that is not coming.
    const manifest = await read({ settingOn: true, isInFlight: true, progress: 'not-running' });
    expect(manifest.isInFlight).toBe(true);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'nothing-displayable' });
  });
});

describe('Feature 203 T039 — where several statements are true at once, the order is asserted', () => {
  it('the setting being off outranks the phase running', async () => {
    // Both true: nothing is recorded because the setting is off, AND the phase
    // is running. Advice to wait is the one wrong answer a wait cannot repair.
    const manifest = await read({ settingOn: false, progress: 'running' });
    expect(manifest.verboseDiagnosticsState).toEqual({
      kind: 'diagnostics-disabled',
      settingKey: 'schegent.logging.verbose'
    });
  });

  it('the phase running outranks nothing having been recorded', async () => {
    const manifest = await read({ settingOn: true, progress: 'running' });
    expect(manifest.iterations).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-running-no-output' });
  });

  it('one entry already read outranks the phase still running', async () => {
    await writeStream(1, ['{"type":"system","subtype":"init"}']);
    const manifest = await read({ settingOn: true, progress: 'running' });
    expect(manifest.entries.length).toBe(1);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'entries-present' });
  });

  it('a record that has produced nothing YET is running, not nothing-displayable', async () => {
    await writeStream(1, ['this is not json']);
    const manifest = await read({ settingOn: true, progress: 'running' });
    expect(manifest.entries).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-running-no-output' });
  });

  it('an unmeasurable progress makes no claim, and never promises output', async () => {
    // `unknown` is not "not running" and is not "running" (D7, FR-016). It
    // degrades to what the tree can be shown to say, never to a promise.
    await fs.mkdir(phaseDirPath(), { recursive: true });
    const manifest = await read({ settingOn: true, progress: 'unknown' });
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'no-iteration-recorded' });
  });
});

describe('Feature 203 T040 — entries-present is exactly the non-empty case', () => {
  it('labels entries-present when and only when the manifest carries entries', async () => {
    // Asserted by construction over the situations that reach BOTH sites able to
    // return this member, not inferred from a failure nobody observed (SC-007).
    const observed: { situation: string; kind: string; entryCount: number }[] = [];
    const record = async (situation: string, options: ReadOptions): Promise<void> => {
      const manifest = await read(options);
      observed.push({
        situation,
        kind: manifest.verboseDiagnosticsState.kind,
        entryCount: manifest.entries.length
      });
    };

    await record('no phase directory at all', { settingOn: true });
    await fs.mkdir(phaseDirPath(), { recursive: true });
    await record('a phase directory holding no iteration', { settingOn: true });
    await makeIterationDir(1);
    await record('an iteration holding no stream', { settingOn: true });
    await writeStream(2, ['this is not json']);
    await record('an iteration whose every line was unreadable', { settingOn: true });
    await writeStream(3, ['{"type":"system","subtype":"init"}']);
    await record('an iteration with one displayable entry', { settingOn: true });

    for (const row of observed) {
      expect(
        row.kind === 'entries-present',
        `${row.situation}: labelled ${row.kind} while carrying ${row.entryCount} entries`
      ).toBe(row.entryCount > 0);
    }

    // Non-vacuity, in both directions. A sweep whose rows all sat on one side of
    // the biconditional would satisfy the loop above without testing it.
    expect(observed.filter((row) => row.entryCount > 0)).toHaveLength(1);
    expect(observed.filter((row) => row.entryCount === 0)).toHaveLength(4);
  });
});
