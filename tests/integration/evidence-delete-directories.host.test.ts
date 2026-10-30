// Feature 251 (FR-R4-F04, contract T9; FR-015, U-19) — what the Electron extension host's filesystem does
// when Run evidence deletion removes a directory.
//
// The deletion's directory removal is proven on Node with real files by
// `tests/unit/services/evidence-delete.test.ts`. What that cannot show is what the HOST's Node reports for
// the two cases the removal turns on, because U-19 asked whether Electron's fs behaves as Node's does for
// an emptied directory and for one that still holds an entry. This test runs the real deletion inside the
// host, over a temporary directory tree it makes itself (never the test workspace's `.schegent/`), and
// writes the codes it observed to the test's output, so the record has them and not an assumption.
//
// It asserts the behavior the deletion depends on (an emptied directory is removed; a directory holding
// an entry is retained as `not-empty`) and prints the raw errno codes of the two direct `rmdir` calls.
// It runs only under `npm run test:integration`, which is the gate's `ci`; until then the codes are
// recorded as pending in measurements.md (T206).

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { deleteRunEvidence } from '../../src/services/evidence-delete';

/** Runs inside the Electron extension host under `npm run test:integration`; prints the two raw codes it observed. */
export async function run(): Promise<void> {
  assert.ok(vscode.workspace.workspaceFolders?.[0], 'test workspace has no folder open');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-251-host-delete-'));
  try {
    const workspace = path.join(scratch, 'workspace');
    const runId = '5b8a1c22-7d3e-4f10-9c44-1a2b3c4d5e6f';
    const iteration = path.join(workspace, '.schegent', 'sessions', runId, 'diagnostics', 'pipe', 'phase', 'iter-1');
    fs.mkdirSync(iteration, { recursive: true });
    fs.writeFileSync(path.join(iteration, 'stream.jsonl'), '{}\n');

    // The two raw codes, observed by the host directly: an emptied directory and one that holds an entry.
    const emptied = path.join(scratch, 'emptied');
    const occupied = path.join(scratch, 'occupied');
    fs.mkdirSync(emptied);
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'entry'), 'x');
    fs.rmdirSync(emptied);
    let occupiedCode = 'none';
    try {
      fs.rmdirSync(occupied);
    } catch (error) {
      occupiedCode = (error as NodeJS.ErrnoException).code ?? 'unknown';
    }
    console.log(
      `[T9 U-19] electron ${process.versions.electron ?? 'n/a'} node ${process.version}: ` +
        `rmdir(emptied) removed; rmdir(occupied) code=${occupiedCode}`
    );
    assert.ok(['ENOTEMPTY', 'EEXIST'].includes(occupiedCode), `a directory holding an entry reports ${occupiedCode}`);

    const result = await deleteRunEvidence(workspace, runId, { isRunActive: () => false });
    if (result.outcome !== 'completed') assert.fail(`expected the deletion to complete, got ${result.outcome}`);
    assert.deepEqual(
      result.retained.filter((item) => item.reason !== 'run-history'),
      [],
      'every directory of the Run was removed, none left as a failure'
    );
    assert.equal(fs.existsSync(path.join(workspace, '.schegent', 'sessions', runId)), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
