import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-078 (T1053) — the check-to-use window on the transcript's end-write and
 * its promotion.
 *
 * The review's finding (`F-03` / `SEC-03`) was not that the containment verdict
 * was wrong. It was true when it was taken. It was that the path was re-resolved
 * BY NAME afterwards: `fs.open(contained, 'a')` for the end marker and
 * `fs.rename(pending, retained)` for the promotion. A workspace writer that swaps
 * a parent component between the verdict and the syscall redirects the write, and
 * what this stream carries is deliberately unredacted by the threat model — so
 * the redirect discloses rather than merely misplaces.
 *
 * These fixtures perform that swap. They do not race: the component is replaced
 * before the operation runs, which is the same tree state the race produces and
 * the state the walk has to refuse.
 *
 * NON-VACUITY (T1054), and what each fixture is and is not evidence of:
 *
 *   - The END-WRITE fixture discriminates. Measured: with
 *     `fs.open(contained, 'a', 0o600)` restored in `doWriteEnd`, the fixture
 *     writes `raw-<id>.log` THROUGH the swapped link into the outside directory,
 *     transcript body and all. Restored, reverted, re-run green.
 *
 *   - The PROMOTION fixture does NOT discriminate, and saying so is the point.
 *     The pre-swap arrangement it builds is refused by the OLD code too:
 *     `resolveContainedLink` resolves the pending file's parent, finds it
 *     outside the workspace, and declines before ever reaching `fs.rename`. A
 *     fixture that passes against both shapes proves the outcome (nothing is
 *     written outside, the pending transcript survives a refusal) and it does
 *     not prove the migration.
 *
 *     What proves the migration for the promotion is structural, and it is the
 *     ledger: `audit/raw-transcript-writer.ts` is struck from `UNMIGRATED` in
 *     `tests/lint/safe-open-migration.test.ts`, whose detector fails the moment
 *     a raw `fs.rename`/`fs.open`/`fs.mkdir` on a composed pathname returns to
 *     this module. That gate IS the non-vacuity control here: restoring the
 *     pathname rename fails it, immediately and by name.
 *
 *     The reason no window fixture exists is worth recording too. The defect is
 *     a swap landing BETWEEN the verdict and the syscall, and the migrated code
 *     has no such interval to inject into — the descriptor is bound before any
 *     adversary can run. Simulating the interval would mean reintroducing the
 *     old shape to test it, which is a test of code that is not shipping.
 */
let workspaceRoot: string;
let outside: string;
let logger: SanitizedLogger;
let warnSpy: MockInstance<(message: string, context?: Record<string, unknown>) => void>;
let writer: RawTranscriptWriter;

const SESSIONS = ['.schegent', 'sessions'];

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-tx-contain-'));
  workspaceRoot = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  logger = new SanitizedLogger();
  warnSpy = vi.spyOn(logger, 'warn');
  writer = new RawTranscriptWriter(workspaceRoot, logger, path.join(workspaceRoot, 'raw-spool'));
});

function refusals(operation: string): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes(`raw transcript ${operation} refused`));
}

/** Replace a real directory in the transcript's path with a link out of the tree. */
async function swapComponentForExternalLink(...segments: string[]): Promise<void> {
  const target = path.join(workspaceRoot, ...segments);
  await fs.rm(target, { recursive: true, force: true });
  await fs.symlink(outside, target, 'dir');
}

describe('FR-R3-078 — the transcript end-write refuses a swapped parent', () => {
  it('refuses, names the refusal, and writes nothing outside the workspace', async () => {
    const runId = 'swap-end';
    await writer.appendStart({ runId, phase: 'speckit-plan', iteration: 1, prompt: 'p' });

    // The swap: `.schegent/sessions` becomes a link to a directory outside the
    // workspace, exactly as a concurrent workspace writer could arrange.
    await swapComponentForExternalLink(...SESSIONS);

    await writer.appendEnd({
      runId,
      stdout: 'unredacted-stdout',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    expect(refusals('transcript-write').length).toBeGreaterThanOrEqual(1);
    // The refusal names the link rather than reporting an I/O error.
    expect(refusals('transcript-write')[0]).toContain('symlink');
    // And nothing reached the outside directory.
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('FR-R3-078 — the transcript promotion refuses a swapped parent', () => {
  // Outcome guard, not a migration proof — see the file header for which is
  // which and what stands in for the missing one.
  it('refuses the promotion and leaves the pending transcript where it is', async () => {
    const runId = 'swap-promote';
    await writer.appendStart({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p',
      mode: 'errors-only'
    });
    await writer.appendEnd({
      runId,
      stdout: 'unredacted-stdout',
      stderr: 'bad',
      exitCode: 1,
      killed: false,
      timedOut: false,
      mode: 'errors-only'
    });
    const pending = path.join(workspaceRoot, ...SESSIONS, '.pending', `raw-${runId}.log`);
    expect(await fs.stat(pending).then((s) => s.isFile())).toBe(true);

    // Swap the destination's parent — the promotion's `wx` open is what must
    // refuse, before any byte of the pending transcript is copied.
    const sessions = path.join(workspaceRoot, ...SESSIONS);
    const stash = path.join(workspaceRoot, '.schegent', 'stash');
    await fs.rename(sessions, stash);
    await fs.symlink(outside, sessions, 'dir');

    await writer.finalizeRun(runId, 'failed', 'errors-only');

    expect(refusals('transcript-promote').length).toBeGreaterThanOrEqual(1);
    // Nothing was written through the link.
    expect(await fs.readdir(outside)).toEqual([]);
    // The pending transcript is the evidence for a run that did not complete;
    // leaving it is the conservative half of the refusal.
    await fs.unlink(sessions);
    await fs.rename(stash, sessions);
    expect(await fs.stat(pending).then((s) => s.isFile())).toBe(true);
  });
});

describe('FR-R3-078 — no adversary present, nothing changes', () => {
  it('produces a byte-identical transcript through write, end and promotion', async () => {
    const runId = 'ordinary';
    await writer.appendStart({
      runId,
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'the prompt',
      mode: 'errors-only'
    });
    await writer.appendEnd({
      runId,
      stdout: 'out-bytes',
      stderr: 'err-bytes',
      exitCode: 3,
      killed: false,
      timedOut: false,
      mode: 'errors-only'
    });
    const pending = path.join(workspaceRoot, ...SESSIONS, '.pending', `raw-${runId}.log`);
    const before = await fs.readFile(pending);

    await writer.finalizeRun(runId, 'failed', 'errors-only');

    const promoted = path.join(workspaceRoot, ...SESSIONS, `raw-${runId}.log`);
    const after = await fs.readFile(promoted);
    // Byte-for-byte: the promotion is a move of the same evidence, and a copy
    // that altered a single byte would be a different document.
    expect(after.equals(before)).toBe(true);
    // The framing is the current build's, not a re-derived one.
    const text = after.toString('utf8');
    expect(text).toContain('[STDOUT]');
    expect(text).toContain('out-bytes');
    expect(text).toContain('[STDERR]');
    expect(text).toContain('err-bytes');
    expect(text).toContain('[EXIT_CODE]: 3');
    // And the source is gone, so the promotion moved rather than duplicated.
    await expect(fs.stat(pending)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/**
 * Feature 217 (FR-003) — every open this writer makes declares a mode, and each
 * one says, once and path-free, what it narrowed. The notices `openWithinRoot`
 * returns used to be dropped at all four open sites and at the ignore-file drop,
 * so the writer narrowed and said nothing. Each fixture widens what exactly one
 * of those opens reaches, so the message can only have come from that open.
 */
describe('Feature 217 (FR-003) — the transcript writer says what its opens narrowed', () => {
  /** POSIX-only: `mode` is not an enforceable concept on Windows. */
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  /** What umask 022 leaves a directory and a file at. */
  const WIDENED_DIR = 0o755;
  const WIDENED_FILE = 0o644;
  const DIRECTORY_NARROWED =
    'raw transcript: an evidence directory granted access beyond its owner (mode 755); narrowed to owner-only';
  const FILE_NARROWED =
    'raw transcript: an evidence file granted access beyond its owner (mode 644); narrowed to owner-only';

  const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;
  const narrowings = (): string[] =>
    warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.startsWith('raw transcript: an evidence'));
  const start = (
    runId: string,
    mode: 'always' | 'errors-only'
  ): Parameters<RawTranscriptWriter['appendStart']>[0] => ({
    runId,
    phase: 'speckit-plan',
    iteration: 1,
    prompt: 'p',
    mode
  });

  posixOnly('the append narrows a widened sessions directory and says so', async () => {
    const sessions = path.join(workspaceRoot, ...SESSIONS);
    await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
    await fs.chmod(sessions, WIDENED_DIR);

    await writer.appendStart(start('narrow-append', 'always'));

    expect(await modeOf(sessions)).toBe(0o700);
    expect(narrowings()).toEqual([DIRECTORY_NARROWED]);
  });

  posixOnly('the end-write narrows a widened transcript and says so', async () => {
    const runId = 'narrow-end';
    // Started by a writer nobody listens to, so the only open this fixture can
    // hear is the end-write's.
    const earlier = new RawTranscriptWriter(
      workspaceRoot,
      new SanitizedLogger(),
      path.join(workspaceRoot, 'raw-spool')
    );
    await earlier.appendStart(start(runId, 'always'));
    const transcript = path.join(workspaceRoot, ...SESSIONS, `raw-${runId}.log`);
    await fs.chmod(transcript, WIDENED_FILE);

    await writer.appendEnd({
      runId,
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      mode: 'always'
    });

    expect(await modeOf(transcript)).toBe(0o600);
    expect(narrowings()).toEqual([FILE_NARROWED]);
  });

  posixOnly('the promotion narrows the directory it creates the retained file in and says so', async () => {
    const runId = 'narrow-promote';
    await writer.appendStart(start(runId, 'errors-only'));
    const sessions = path.join(workspaceRoot, ...SESSIONS);
    await fs.chmod(sessions, WIDENED_DIR);

    await writer.finalizeRun(runId, 'failed', 'errors-only');

    expect(await modeOf(sessions)).toBe(0o700);
    expect(narrowings()).toEqual([DIRECTORY_NARROWED]);
  });

  posixOnly('the promotion narrows a retained transcript it appends to and says so', async () => {
    const runId = 'narrow-resume';
    await writer.appendStart(start(runId, 'errors-only'));
    // An earlier leg's retained transcript, widened. The promotion's `wx` open
    // refuses with EEXIST and narrows nothing, so the reopen for append is the
    // open that reaches it.
    const retained = path.join(workspaceRoot, ...SESSIONS, `raw-${runId}.log`);
    await fs.writeFile(retained, 'earlier leg\n');
    await fs.chmod(retained, WIDENED_FILE);

    await writer.finalizeRun(runId, 'failed', 'errors-only');

    expect(await modeOf(retained)).toBe(0o600);
    expect(narrowings()).toEqual([FILE_NARROWED]);
  });

  posixOnly('the ignore-file drop narrows a widened `.schegent` and says so through this writer', async () => {
    const schegent = path.join(workspaceRoot, '.schegent');
    await fs.mkdir(schegent);
    await fs.chmod(schegent, WIDENED_DIR);

    await writer.appendStart(start('narrow-ignore', 'always'));

    expect(await modeOf(schegent)).toBe(0o700);
    expect(narrowings()).toEqual([DIRECTORY_NARROWED]);
  });
});
