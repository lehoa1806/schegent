// Code-review finding — `RunSessionRegistry`'s reap, unit-tested at the class.
//
// `size` reaps before counting so the number the concurrency cap reads is
// honest at the moment it is read (see the module's own two long notes). The
// third guard below is the one this file exists for: the reap deletes the
// SESSION, and the session owns the `-c` continuation gate, so a reap that
// fires between arming and driving silently downgrades a resumed conversation
// to a new one. The claim it replaced — "a gate is only ever armed for a Run
// about to be resumed, which is by definition not terminal" — is false in tree,
// because `resumeExistingOnQueue` refuses only `completed` and `canceled`, so a
// `failed` Run being retried is armed while its persisted status is terminal.
//
// The integration suites cover the cap arithmetic through the real controller;
// these assert the guards themselves, where an interleaving can be stated
// exactly rather than provoked.

import { describe, expect, it } from 'vitest';
import { RunSessionRegistry } from '../../../src/controller/run-session';
import type { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';

/** A driver stub whose only relevant state is whether it is mid-drive. */
function fakeDriver(): RunDriver & { running: boolean } {
  return { running: false } as unknown as RunDriver & { running: boolean };
}

function runWith(status: WorkflowRunStatus): WorkflowRun {
  return { id: 'run-1', status } as unknown as WorkflowRun;
}

function registryFor(run: WorkflowRun | null): {
  readonly registry: RunSessionRegistry;
  readonly drivers: (RunDriver & { running: boolean })[];
} {
  const drivers: (RunDriver & { running: boolean })[] = [];
  const registry = new RunSessionRegistry(
    () => {
      const driver = fakeDriver();
      drivers.push(driver);
      return driver;
    },
    () => run
  );
  return { registry, drivers };
}

describe('RunSessionRegistry reap guards', () => {
  it('reaps an idle session whose Run has ended, and counts what is left', () => {
    const { registry } = registryFor(runWith('failed'));
    registry.acquire('q-alpha');
    expect(registry.size).toBe(0);
    expect(registry.peek('q-alpha')).toBeNull();
  });

  it('refuses to reap a session whose driver is mid-drive', () => {
    const { registry, drivers } = registryFor(runWith('failed'));
    registry.acquire('q-alpha');
    drivers[0].running = true;
    expect(registry.size).toBe(1);
  });

  it('refuses to reap a paused Run, which keeps its slot for the resume (RS-3)', () => {
    const { registry } = registryFor(runWith('paused'));
    registry.acquire('q-alpha');
    expect(registry.size).toBe(1);
  });

  // The regression. A `failed` Run reaches the arm in `resumeExistingOnQueue`,
  // and the consent await that follows holds the window open for as long as an
  // operator takes to answer a modal. Any drain sweep reading `size` in that
  // window used to delete the session, so `driveSession`'s `acquire` minted a
  // fresh gate and the retry dispatched WITHOUT `-c` — a new conversation for a
  // Run that was continuing one, with nothing in the log to say so.
  it('refuses to reap an armed continuation even when the Run is terminal', () => {
    const { registry } = registryFor(runWith('failed'));
    const session = registry.acquire('q-alpha');
    session.isContinueGate.arm();

    expect(registry.size).toBe(1);
    // The same session, so the gate the drive consumes is the one that was armed.
    expect(registry.peek('q-alpha')).toBe(session);
    expect(session.isContinueGate.consume()).toBe(true);
  });

  it('collects the session once the drive has consumed the gate', () => {
    const { registry } = registryFor(runWith('completed'));
    const session = registry.acquire('q-alpha');
    session.isContinueGate.arm();
    expect(registry.size).toBe(1);

    session.isContinueGate.consume();
    expect(registry.size).toBe(0);
  });

  // What keeps the guard from stranding a slot: a resume refused after arming
  // says the continuation is spent, and then the slot goes. `admitResume`'s
  // `finally` is the production caller of this pair.
  it('collects the session once an abandoned continuation is disarmed', () => {
    const { registry } = registryFor(runWith('failed'));
    const session = registry.acquire('q-alpha');
    session.isContinueGate.arm();
    expect(registry.disposeIfEnded('q-alpha')).toBe(false);

    session.isContinueGate.disarm();
    expect(registry.disposeIfEnded('q-alpha')).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('reaps one queue and leaves its siblings alone (RS-5)', () => {
    const { registry } = registryFor(runWith('canceled'));
    const armed = registry.acquire('q-alpha');
    armed.isContinueGate.arm();
    registry.acquire('q-beta');

    expect(registry.size).toBe(1);
    expect(registry.peek('q-alpha')).toBe(armed);
    expect(registry.peek('q-beta')).toBeNull();
  });
});
