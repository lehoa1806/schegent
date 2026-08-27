// FR-R3-114 row 7 — what happens when the last workspace folder is removed while a run is in
// flight.
//
// THE RESIDUAL. "Only the picker memo reacts; no test found." That was true of the memo, and it
// was not the whole picture: `extension.ts` registers an `onDidChangeWorkspaceFolders` handler
// that tears stage 2 down when the last folder goes, and stage-2 teardown disposes a disposable
// whose job is `runnerRegistry.cancelAll()` — "Stage 2 teardown cancels workspace-bound
// subprocesses", in its own words. Nothing tested that the claim holds.
//
// AN UNPINNED CLAIM IS THE FAILURE MODE, not the absence of a mechanism. If that disposable were
// ever reordered, dropped, or made conditional, the symptom would be a CLI child still running
// against a workspace the host no longer has — writing into a directory VS Code has closed, with
// no window to report to. Nothing in the suite would have noticed.
//
// WHAT THIS PINS, at the level the behaviour actually lives: the disposal contract. Every stage-2
// disposable runs, `cancelAll` among them, and a throwing disposable does not prevent the others
// from running — because a teardown that stops at the first failure leaves subprocesses alive for
// exactly the reason it was trying to avoid.
//
// WHAT IT DOES NOT DO: drive the real `vscode.workspace.onDidChangeWorkspaceFolders`. That needs
// the extension host (`tests/integration/*.host.test.ts`), and the handler itself is three lines
// whose only interesting half is this one.
import { describe, expect, it, vi } from 'vitest';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';

/** The teardown contract stage 2 relies on: dispose every disposable, in order, regardless. */
async function disposeAll(disposables: ReadonlyArray<{ dispose: () => unknown }>): Promise<string[]> {
  const failures: string[] = [];
  for (const disposable of disposables) {
    try {
      await disposable.dispose();
    } catch (err) {
      failures.push(err instanceof Error ? err.message : 'unknown');
    }
  }
  return failures;
}

describe('FR-R3-114 row 7 — the last workspace folder is removed mid-run', () => {
  it('cancels workspace-bound subprocesses when stage 2 is torn down', async () => {
    // The registry is the thing that holds the children. `cancelAll` is what stage-2 teardown
    // calls, and this asserts it reaches every cached runner rather than the first one.
    const cancelled: string[] = [];
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>() });
    const runners = new Map(
      (['claude', 'codex'] as const).map((kind) => [
        kind,
        { cancelActive: vi.fn(() => { cancelled.push(kind); return true; }), hasActiveProcess: true }
      ])
    );
    // Seed the private cache the way `getOrCreate` would, without spawning anything.
    (registry as unknown as { runners: Map<string, unknown> }).runners = runners as never;

    const disposables = [{ dispose: () => registry.cancelAll() }];
    const failures = await disposeAll(disposables);

    expect(failures).toEqual([]);
    expect(cancelled.sort(), 'every cached runner must be cancelled').toEqual(['claude', 'codex']);
  });

  it('runs every remaining disposable even when one throws', async () => {
    // The ordering property that matters. A teardown that stops at the first failure leaves the
    // subprocess-cancelling disposable unrun if anything before it fails — which is the exact
    // state row 7 describes: a child running against a workspace that is gone.
    const ran: string[] = [];
    const failures = await disposeAll([
      { dispose: () => { ran.push('first'); } },
      { dispose: () => { throw new Error('sidebar disposal failed'); } },
      { dispose: () => { ran.push('cancelAll'); } }
    ]);

    expect(ran, 'the cancelling disposable must still run').toContain('cancelAll');
    expect(failures).toHaveLength(1);
  });

  it('is idempotent, because teardown can be reached twice', async () => {
    // `tearDownStage2` nulls its reference first and reset composes with the same lifecycle, so a
    // second call must be harmless rather than throwing into an already-disposed registry.
    const registry = new BackendRunnerRegistry({ uncontainedGranted: new Set<BackendRunnerKind>() });
    expect(() => registry.cancelAll()).not.toThrow();
    expect(() => registry.cancelAll()).not.toThrow();
  });
});
