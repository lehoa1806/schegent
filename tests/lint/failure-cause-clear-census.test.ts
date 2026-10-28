// FR-R4-F14 (spec 242, contract W5, TA1 and TA5; hard rules 28 and 67) — every write that leaves a pause
// or a failure also names the failure cause.
//
// `WorkflowRun.failureCause` is one optional code, and `validateRunInvariants` refuses it beside any
// status but `failed`. That is the runtime backstop: a writer that leaves `failed` and forgets to
// drop the code throws instead of persisting a record two readers would disagree about. This gate is
// the build-time half. Every site that makes a Run leave `paused` or `failed`, or write `failed`
// itself, writes `pendingRetryCause: null` (the retry pair is the field they all clear), so the files
// that write it are the census of "writes that move a Run across `failed`", and each must also name
// `failureCause` (to set it, or to clear it) or carry a classified reason why it does not.
//
// The search term is a FIELD NAME with its cleared value, never a status literal (hard rule 67):
// `'failed'` and `null` are shared vocabulary across subsystems, and a gate whose term can match
// something it was not written about reports green for a site it never saw. It is the term the
// credit-pause gate uses, so the two censuses read the same set of files.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const RETRY_PAIR_CLEAR = 'pendingRetryCause: null';
const FAILURE_CAUSE = 'failureCause';

/**
 * Non-test source files that write `pendingRetryCause: null` and do NOT move a Run out of `failed`
 * (or into it), each with the one-line reason. An entry is a decision, not a convenience.
 */
const DOES_NOT_LEAVE_FAILED: Readonly<Record<string, string>> = {
  'src/controller/retry-handler.ts':
    'its two writes pause a running Run for a delayed retry; a running Run carries no failure cause',
  'src/controller/manual-retry-override.ts':
    'its patch leaves status as it is, so a failed Run keeps its code',
  'src/services/run-advance.ts': 'it advances a running Run to its next phase',
  'src/services/workflow-run-factory.ts': 'it creates a Run, which starts running with no cause',
  'src/state/workflow-run-migrator.ts': 'it migrates a persisted shape and writes no cause',
  'src/state/orphaned-run-reconciler.ts':
    'it ends only non-terminal Runs; failed is terminal, so a failed Run passes through unchanged (TA1)',
  'src/ui/sidebar/snapshot.ts':
    'IDLE_DELAYED_RETRY is a DelayedRetryState projection default (pendingRetryAt, pendingRetryCause, delayedRetryCount), not a WorkflowRun'
};

/**
 * The vacuity controls (`scanning-gates-prove-they-scanned`). Twelve files write the pair at
 * `9cc9e16b` (TA1). `MIN_SITES` is a floor, not a count, and `ANCHOR` is the controller file whose
 * three revive patches are the reason the census exists.
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

function sourceOf(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

describe('FR-R4-F14 (W5) — every write that moves a Run across failed names failureCause', () => {
  const pairWriters = filesContaining(RETRY_PAIR_CLEAR);

  it('control: the scan finds the sites it is about', () => {
    expect(pairWriters.length).toBeGreaterThanOrEqual(MIN_SITES);
    expect(pairWriters).toContain(ANCHOR);
  });

  it('every file that writes pendingRetryCause: null also names failureCause, or is classified', () => {
    const unnamed = pairWriters.filter(
      (file) => !(file in DOES_NOT_LEAVE_FAILED) && !sourceOf(file).includes(FAILURE_CAUSE)
    );
    expect(
      unnamed,
      `these files write a Run across a pause or a failure (\`${RETRY_PAIR_CLEAR}\`) without naming ` +
        `\`${FAILURE_CAUSE}\`. validateRunInvariants refuses a cause beside a non-failed status at ` +
        `runtime; set or clear the field in the patch, or give the file a one-line reason in ` +
        `DOES_NOT_LEAVE_FAILED.`
    ).toEqual([]);
  });

  it('every classified exception still writes the pair term', () => {
    for (const file of Object.keys(DOES_NOT_LEAVE_FAILED)) {
      expect(
        sourceOf(file).includes(RETRY_PAIR_CLEAR),
        `${file} no longer writes ${RETRY_PAIR_CLEAR}; remove its entry`
      ).toBe(true);
    }
  });

  it('control: the field name hits where it is declared and where a clearing patch is written', () => {
    // If these find nothing the second test above would pass for every file and prove nothing.
    expect(filesContaining(FAILURE_CAUSE)).toContain('src/state/workflow-run.ts');
    expect(filesContaining(`${FAILURE_CAUSE}: undefined`)).toContain('src/controller/resume-pause-fields.ts');
  });
});
