// Feature 058 (US2, T005) — picker unit tests for `getCanonicalWorkspaceRoot()`
// and `disposeWorkspaceFolderPicker()`. Covers U-1..U-7 from
// `specs/058-multi-root-workspace/contracts/workspace-folder-picker-contract.md`.
//
// Mock pattern mirrors `configuration-access.test.ts`: a `vi.hoisted` state with
// a mutable `workspaceFolders` field and a `listeners` set for
// `onDidChangeWorkspaceFolders` subscribers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockFolder {
  readonly uri: { readonly fsPath: string; readonly scheme: string };
  readonly name: string;
  readonly index: number;
}

const mocks = vi.hoisted(() => {
  type Listener = (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>;
  const state = {
    workspaceFolders: undefined as readonly { uri: { fsPath: string; scheme: string }; name: string; index: number }[] | undefined,
    listeners: new Set<Listener>()
  };
  return { state };
});

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mocks.state.workspaceFolders;
    },
    onDidChangeWorkspaceFolders: (
      listener: (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>
    ) => {
      mocks.state.listeners.add(listener);
      return {
        dispose: () => {
          mocks.state.listeners.delete(listener);
        }
      };
    }
  }
}));

// Imported after the mock is registered so the module-level subscription
// (if any) resolves against the mock — though per C-2 the subscription is
// lazy and only created on the first `getCanonicalWorkspaceRoot()` call.
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from '../../../src/state/workspace-folder-picker';

function makeFolder(fsPath: string, name: string, index: number): MockFolder {
  return {
    uri: { fsPath, scheme: 'file' },
    name,
    index
  };
}

async function fireChange(): Promise<void> {
  const handlers = Array.from(mocks.state.listeners);
  await Promise.all(handlers.map(async (fn) => fn({ added: [], removed: [] })));
}

beforeEach(() => {
  // Each test starts with a fresh picker state. dispose is idempotent so
  // calling it here even when the picker holds no state is safe.
  disposeWorkspaceFolderPicker();
  mocks.state.workspaceFolders = undefined;
  mocks.state.listeners.clear();
});

describe('workspace-folder-picker (058, T005)', () => {
  it('U-1: returns undefined when workspaceFolders is undefined', () => {
    mocks.state.workspaceFolders = undefined;
    expect(getCanonicalWorkspaceRoot()).toBeUndefined();
  });

  it('U-1b: returns undefined when workspaceFolders is an empty array', () => {
    mocks.state.workspaceFolders = [];
    expect(getCanonicalWorkspaceRoot()).toBeUndefined();
  });

  it('U-2: returns the single folder when exactly one is open', () => {
    const only = makeFolder('/tmp/ws-only', 'ws-only', 0);
    mocks.state.workspaceFolders = [only];
    const got = getCanonicalWorkspaceRoot();
    expect(got).toBe(only);
  });

  it('U-3: returns the first folder when two or more are open', () => {
    const first = makeFolder('/tmp/ws-first', 'ws-first', 0);
    const second = makeFolder('/tmp/ws-second', 'ws-second', 1);
    const third = makeFolder('/tmp/ws-third', 'ws-third', 2);
    mocks.state.workspaceFolders = [first, second, third];
    expect(getCanonicalWorkspaceRoot()).toBe(first);
  });

  it('U-4: second call returns the same reference (memoization)', () => {
    const first = makeFolder('/tmp/ws-first', 'ws-first', 0);
    const second = makeFolder('/tmp/ws-second', 'ws-second', 1);
    mocks.state.workspaceFolders = [first, second];
    const a = getCanonicalWorkspaceRoot();
    // Mutate the underlying state — memoized picker should NOT see this until
    // a change event fires.
    const third = makeFolder('/tmp/ws-third', 'ws-third', 0);
    mocks.state.workspaceFolders = [third, first];
    const b = getCanonicalWorkspaceRoot();
    expect(b).toBe(a);
    expect(b).toBe(first);
  });

  it('U-5: cache resets after onDidChangeWorkspaceFolders fires', async () => {
    const first = makeFolder('/tmp/ws-first', 'ws-first', 0);
    mocks.state.workspaceFolders = [first];
    // First call to register the lazy subscription.
    expect(getCanonicalWorkspaceRoot()).toBe(first);
    expect(mocks.state.listeners.size).toBe(1);

    // Swap the workspace.
    const second = makeFolder('/tmp/ws-second', 'ws-second', 0);
    mocks.state.workspaceFolders = [second];

    // Without firing the change event, the picker would still return the cached
    // first folder.
    expect(getCanonicalWorkspaceRoot()).toBe(first);

    // After the change event, the next call must reflect the new state.
    await fireChange();
    expect(getCanonicalWorkspaceRoot()).toBe(second);
  });

  it('U-5b: subscription is created lazily (not at module load)', () => {
    // Fresh state already cleared in beforeEach.
    expect(mocks.state.listeners.size).toBe(0);
    mocks.state.workspaceFolders = [makeFolder('/tmp/ws', 'ws', 0)];
    // Reading does NOT auto-register; subscription happens on the first call.
    getCanonicalWorkspaceRoot();
    expect(mocks.state.listeners.size).toBe(1);
  });

  it('U-6: after dispose, calls return the live value without throwing', () => {
    const first = makeFolder('/tmp/ws-first', 'ws-first', 0);
    mocks.state.workspaceFolders = [first];
    expect(getCanonicalWorkspaceRoot()).toBe(first);

    disposeWorkspaceFolderPicker();
    // Listener cleaned up.
    expect(mocks.state.listeners.size).toBe(0);

    // Live read against the current state — no cache, no throw.
    const replaced = makeFolder('/tmp/ws-replaced', 'ws-replaced', 0);
    mocks.state.workspaceFolders = [replaced];
    expect(() => getCanonicalWorkspaceRoot()).not.toThrow();
    expect(getCanonicalWorkspaceRoot()).toBe(replaced);
  });

  it('U-7: dispose is idempotent', () => {
    mocks.state.workspaceFolders = [makeFolder('/tmp/ws', 'ws', 0)];
    getCanonicalWorkspaceRoot();
    expect(() => disposeWorkspaceFolderPicker()).not.toThrow();
    expect(() => disposeWorkspaceFolderPicker()).not.toThrow();
    expect(() => disposeWorkspaceFolderPicker()).not.toThrow();
    expect(mocks.state.listeners.size).toBe(0);
  });
});
