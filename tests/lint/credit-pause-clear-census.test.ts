// FR-R4-F02 (spec 240, TA2; data-model §3 writers; hard rule 28) — every write that leaves a pause
// also clears the credit-pause record.
//
// `WorkflowRun.creditPause` is one nullable object, and `validateRunInvariants` refuses it beside a
// non-paused status, a retry pair or a manual pair. That is the runtime backstop: a forgotten site
// throws instead of persisting a half state. This gate is the build-time half. Every site that
// leaves `paused` writes `pendingRetryCause: null` (the retry pair is the pause field they all
// clear), so the files that write it are the census of "writes that leave a pause", and each must
// also write `creditPause: null` — or carry a classified reason why it does not.
//
// The search term is the pair of FIELD NAMES with their cleared value, never a status literal
// (hard rule 67): `'paused'` and `null` are shared vocabulary across subsystems, and a gate whose
// term can match something it was not written about reports green for a second site it never saw.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PAUSE_CLEAR = 'pendingRetryCause: null';
const CREDIT_CLEAR = 'creditPause: null';

/**
 * Non-test source files that write `pendingRetryCause: null` and are NOT a write leaving a pause,
 * each with the one-line reason. An entry is a decision, not a convenience: it says the file's
 * `pendingRetryCause: null` is not a `WorkflowRun` patch.
 */
const NOT_A_RUN_WRITE: Readonly<Record<string, string>> = {
  'src/ui/sidebar/snapshot.ts':
    'IDLE_DELAYED_RETRY is a DelayedRetryState projection default (pendingRetryAt, pendingRetryCause, delayedRetryCount), not a WorkflowRun'
};

/**
 * The vacuity controls (`scanning-gates-prove-they-scanned`). Twelve files write the pair at
 * `5d700407` (TA2). `MIN_SITES` is a floor, not a count, and `ANCHOR` is the controller file whose
 * four patches are the reason the census exists.
 */
const MIN_SITES = 10;
const ANCHOR = 'src/controller/phase-control-service.ts';

function collectSourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (path.extname(entry.name) !== '.ts') continue;
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

function filesContaining(term: string): string[] {
  const root = process.cwd();
  return collectSourceFiles(path.resolve(root, 'src'), [])
    .filter((file) => fs.readFileSync(file, 'utf8').includes(term))
    .map((file) => path.relative(root, file))
    .sort();
}

describe('FR-R4-F02 (TA2) — every write that leaves a pause clears creditPause', () => {
  const pauseWriters = filesContaining(PAUSE_CLEAR);

  it('control: the scan finds the sites it is about', () => {
    expect(pauseWriters.length).toBeGreaterThanOrEqual(MIN_SITES);
    expect(pauseWriters).toContain(ANCHOR);
  });

  it('every file that writes pendingRetryCause: null also writes creditPause: null, or is classified', () => {
    const unclear = pauseWriters.filter(
      (file) =>
        !(file in NOT_A_RUN_WRITE) &&
        !fs.readFileSync(path.resolve(process.cwd(), file), 'utf8').includes(CREDIT_CLEAR)
    );
    expect(
      unclear,
      `these files clear a pause (\`${PAUSE_CLEAR}\`) without clearing the credit pause ` +
        `(\`${CREDIT_CLEAR}\`). validateRunInvariants refuses the half state at runtime; add the ` +
        `field to the patch, or give the file a one-line reason in NOT_A_RUN_WRITE.`
    ).toEqual([]);
  });

  it('every classified exception still names the pause field and still lacks the credit field', () => {
    for (const file of Object.keys(NOT_A_RUN_WRITE)) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source.includes(PAUSE_CLEAR), `${file} no longer writes ${PAUSE_CLEAR}`).toBe(true);
      expect(source.includes(CREDIT_CLEAR), `${file} now clears the credit pause`).toBe(false);
    }
  });

  it('control: the clearing term hits where the record is declared', () => {
    // `canceledRunPatch` lives beside the `CreditPause` declaration and writes the clear. If this
    // finds nothing the second test above would fail for every file and prove nothing about one.
    expect(filesContaining(CREDIT_CLEAR)).toContain('src/state/workflow-run.ts');
  });
});
