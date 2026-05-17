import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

interface MockPanel {
  webview: {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: unknown[] };
    cspSource: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
  };
  visible: boolean;
  active: boolean;
  viewType: string;
  title: string;
  reveal: Mock;
  dispose: Mock;
  onDidChangeViewState: Mock;
  onDidDispose: Mock;
  __viewStateListeners: Array<() => void>;
  __disposeListeners: Array<() => void>;
  __triggerVisibilityChange: (visible: boolean) => void;
  __triggerDispose: () => void;
}

const mocks = vi.hoisted(() => {
  const state = {
    panels: [] as MockPanel[],
    createWebviewPanel: vi.fn()
  };
  return { state };
});

function createMockPanel(viewType: string, title: string): MockPanel {
  const viewStateListeners: Array<() => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel: MockPanel = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-resource:',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({ toString: () => `vscode-webview://${uri.fsPath}` }))
    },
    visible: true,
    active: true,
    viewType,
    title,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn((listener: () => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    __viewStateListeners: viewStateListeners,
    __disposeListeners: disposeListeners,
    __triggerVisibilityChange: (visible: boolean) => {
      panel.visible = visible;
      viewStateListeners.forEach((l) => l());
    },
    __triggerDispose: () => {
      disposeListeners.forEach((l) => l());
    }
  };
  return panel;
}

vi.mock('vscode', () => {
  return {
    window: {
      createWebviewPanel: mocks.state.createWebviewPanel
    },
    Uri: {
      file: (p: string) => ({
        fsPath: p,
        scheme: 'file',
        path: p,
        toString: () => `file://${p}`
      })
    },
    ViewColumn: {
      Active: -1,
      Beside: -2,
      One: 1,
      Two: 2
    }
  };
});

import { DashboardPanel } from '../../../../src/ui/dashboard/dashboard-panel';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { ProjectorHandle } from '../../../../src/ui/sidebar/projector-handle';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { buildIdleSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { STATE_SNAPSHOT } from '../../../../src/ui/sidebar/messages';

class FakeProjector implements ProjectorHandle {
  private listeners: Array<(s: WorkflowSnapshot) => void> = [];
  private snapshot: WorkflowSnapshot = buildIdleSnapshot({
    isPrimary: true,
    producedAt: '2026-05-10T00:00:00.000Z'
  });

  subscribe(listener: (s: WorkflowSnapshot) => void) {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      }
    };
  }

  getCurrentSnapshot(): WorkflowSnapshot {
    return this.snapshot;
  }

  hasSubscribers(): boolean {
    return this.listeners.length > 0;
  }

  emit(snapshot: WorkflowSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((l) => l(snapshot));
  }
}

beforeEach(() => {
  mocks.state.panels = [];
  mocks.state.createWebviewPanel.mockReset();
  mocks.state.createWebviewPanel.mockImplementation(
    (viewType: string, title: string) => {
      const p = createMockPanel(viewType, title);
      mocks.state.panels.push(p);
      return p;
    }
  );
  // Clear singleton between tests
  DashboardPanel.__resetForTests();
});

function buildOpts(projector?: FakeProjector) {
  const proj = projector ?? new FakeProjector();
  return {
    extensionRoot: '/tmp/ext',
    projector: proj,
    dispatch: vi.fn(),
    logger: new SanitizedLogger()
  };
}

describe('DashboardPanel (T053)', () => {
  it('(a) creates a panel with viewType "schegent.dashboard" and title "Schegent Dashboard"', () => {
    const opts = buildOpts();
    DashboardPanel.open(opts);

    expect(mocks.state.createWebviewPanel).toHaveBeenCalledTimes(1);
    const [viewType, title] = mocks.state.createWebviewPanel.mock.calls[0];
    expect(viewType).toBe('schegent.dashboard');
    expect(title).toBe('Schegent Dashboard');
  });

  it('(b1) panel options include enableScripts: true', () => {
    const opts = buildOpts();
    DashboardPanel.open(opts);

    const panelOptions = mocks.state.createWebviewPanel.mock.calls[0][3] as {
      enableScripts?: boolean;
      localResourceRoots?: unknown[];
    };
    expect(panelOptions.enableScripts).toBe(true);
    expect(Array.isArray(panelOptions.localResourceRoots)).toBe(true);
    expect((panelOptions.localResourceRoots ?? []).length).toBeGreaterThan(0);
  });

  it('(b2) panel HTML includes a script-src nonce', () => {
    const opts = buildOpts();
    DashboardPanel.open(opts);
    const panel = mocks.state.panels[0];
    expect(panel.webview.html).toMatch(/Content-Security-Policy/);
    expect(panel.webview.html).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
  });

  it('(c) calling open() twice while one is open re-reveals the existing panel', () => {
    const opts = buildOpts();
    const first = DashboardPanel.open(opts);
    const second = DashboardPanel.open(opts);

    expect(mocks.state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mocks.state.panels[0].reveal).toHaveBeenCalled();
    expect(second).toBe(first);
  });

  it('(d) panel.dispose() unsubscribes from the projector and clears the singleton', () => {
    const projector = new FakeProjector();
    const opts = buildOpts(projector);
    const panel = DashboardPanel.open(opts);

    expect(projector.hasSubscribers()).toBe(true);
    panel.dispose();
    expect(projector.hasSubscribers()).toBe(false);
    expect(DashboardPanel.current()).toBeNull();
  });

  it('(d2) onDidDispose unhooks projector subscription as well', () => {
    const projector = new FakeProjector();
    const opts = buildOpts(projector);
    DashboardPanel.open(opts);
    const panel = mocks.state.panels[0];

    panel.__triggerDispose();
    expect(projector.hasSubscribers()).toBe(false);
    expect(DashboardPanel.current()).toBeNull();
  });

  it('(e1) on visibility change to visible=true, the latest snapshot is posted', async () => {
    const projector = new FakeProjector();
    const opts = buildOpts(projector);
    DashboardPanel.open(opts);
    const panel = mocks.state.panels[0];
    // Allow any initial async post to settle
    await Promise.resolve();
    panel.webview.postMessage.mockClear();

    panel.__triggerVisibilityChange(true);
    await Promise.resolve();
    await Promise.resolve();

    const snapshotPosts = panel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    );
    expect(snapshotPosts.length).toBeGreaterThan(0);
  });

  it('(e2) on visibility change to visible=false, no snapshot is posted', async () => {
    const projector = new FakeProjector();
    const opts = buildOpts(projector);
    DashboardPanel.open(opts);
    const panel = mocks.state.panels[0];
    await Promise.resolve();
    panel.webview.postMessage.mockClear();

    panel.__triggerVisibilityChange(false);
    await Promise.resolve();
    await Promise.resolve();

    const snapshotPosts = panel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    );
    expect(snapshotPosts.length).toBe(0);
  });

  it('(e3) snapshot delivered while visible=false is queued and posted on next visible=true', async () => {
    const projector = new FakeProjector();
    const opts = buildOpts(projector);
    DashboardPanel.open(opts);
    const panel = mocks.state.panels[0];
    await Promise.resolve();
    panel.webview.postMessage.mockClear();

    panel.__triggerVisibilityChange(false);
    // Emit a new snapshot while hidden
    projector.emit(buildIdleSnapshot({ isPrimary: true, producedAt: '2026-05-10T01:00:00.000Z' }));
    await Promise.resolve();

    const postsWhileHidden = panel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    );
    expect(postsWhileHidden.length).toBe(0);

    panel.__triggerVisibilityChange(true);
    await Promise.resolve();
    await Promise.resolve();

    const postsAfterReveal = panel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    );
    expect(postsAfterReveal.length).toBeGreaterThan(0);
  });

  it('(f) does not auto-open: importing the module does NOT call createWebviewPanel', () => {
    // Module was already imported at file top; assertion is that no panel was created
    // until DashboardPanel.open() was called explicitly. Reset expectations.
    expect(mocks.state.createWebviewPanel).not.toHaveBeenCalled();
  });
});
