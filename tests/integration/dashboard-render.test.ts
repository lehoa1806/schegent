import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MockWebview {
  html: string;
  options: { enableScripts?: boolean; localResourceRoots?: unknown[] };
  cspSource: string;
  postMessage: Mock;
  onDidReceiveMessage: Mock;
  asWebviewUri: Mock;
}

interface MockPanel {
  webview: MockWebview;
  visible: boolean;
  active: boolean;
  viewType: string;
  title: string;
  reveal: Mock;
  dispose: Mock;
  onDidChangeViewState: Mock;
  onDidDispose: Mock;
}

const mocks = vi.hoisted(() => {
  const state = {
    panels: [] as MockPanel[],
    createWebviewPanel: vi.fn()
  };
  return { state };
});

function createMockPanel(viewType: string, title: string): MockPanel {
  const panel: MockPanel = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-resource:',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      asWebviewUri: vi.fn((uri: { fsPath: string; scheme?: string }) => {
        // BUG-001: real `vscode.Webview.asWebviewUri` rejects partial duck-typed
        // shapes. Mirror that contract so test failures surface regressions
        // where callers omit `toLocalUri` and fall back to `{ fsPath }` literals.
        if (typeof uri?.scheme !== 'string' || uri.scheme.length === 0) {
          throw new TypeError(
            'mock asWebviewUri requires a Uri-shaped argument with a non-empty `scheme`'
          );
        }
        return {
          toString: () => `vscode-webview://${uri.fsPath}`
        };
      })
    },
    visible: true,
    active: true,
    viewType,
    title,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() })
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

import { DashboardPanel } from '../../src/ui/dashboard/dashboard-panel';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ProjectorHandle } from '../../src/ui/sidebar/projector-handle';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { buildIdleSnapshot } from '../../src/ui/sidebar/snapshot';
import { STATE_SNAPSHOT } from '../../src/ui/sidebar/messages';

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
  DashboardPanel.__resetForTests();
});

describe('Dashboard render integration (T062)', () => {
  it('(a) opening dashboard via DashboardPanel.open() produces a Webview panel', () => {
    const projector = new FakeProjector();
    DashboardPanel.open({
      extensionRoot: '/tmp/ext',
      projector,
      dispatch: vi.fn(),
      logger: new SanitizedLogger()
    });
    expect(mocks.state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mocks.state.panels[0].viewType).toBe('schegent.dashboard');
  });

  it('(b) dashboard bundle references the FR-033 layout-zone testids', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const bundlePath = path.join(repoRoot, 'dist', 'webview', 'dashboard.js');
    if (!fs.existsSync(bundlePath)) {
      console.warn(`[T062] skipping bundle check: ${bundlePath} not found (run npm run build:webview)`);
      return;
    }
    const bundleSource = fs.readFileSync(bundlePath, 'utf8');
    expect(bundleSource).toContain('dashboard-queue-input');
    expect(bundleSource).toContain('dashboard-queue-management');
    expect(bundleSource).toContain('dashboard-queue-list');
    expect(bundleSource).toContain('dashboard-phase-progression');
    expect(bundleSource).toContain('dashboard-activity-audit-feed');
  });

  it('(c) dashboard panel HTML carries a Content-Security-Policy meta with nonce', () => {
    const projector = new FakeProjector();
    DashboardPanel.open({
      extensionRoot: '/tmp/ext',
      projector,
      dispatch: vi.fn(),
      logger: new SanitizedLogger()
    });
    const html = mocks.state.panels[0].webview.html;
    expect(html).toMatch(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
  });

  it('(e) dashboard panel HTML rebases the Vite-emitted asset graph (BUG-001)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const bundlePath = path.join(repoRoot, 'dist', 'webview', 'dashboard.html');
    if (!fs.existsSync(bundlePath)) {
      console.warn(`[BUG-001] skipping rebase check: ${bundlePath} not found (run npm run build:webview)`);
      return;
    }
    const projector = new FakeProjector();
    DashboardPanel.open({
      extensionRoot: repoRoot,
      projector,
      dispatch: vi.fn(),
      logger: new SanitizedLogger()
    });
    const html = mocks.state.panels[0].webview.html;
    // Every Vite-emitted asset reference must be rewritten through asWebviewUri.
    expect(html).toMatch(/vscode-webview:\/\/[^"]*dashboard\.js/);
    expect(html).toMatch(/vscode-webview:\/\/[^"]*chunks\/theme\.js/);
    expect(html).toMatch(/vscode-webview:\/\/[^"]*index2\.css/);
    expect(html).toMatch(/vscode-webview:\/\/[^"]*dashboard\.css/);
    // crossorigin must be stripped (incompatible with VS Code webview iframe).
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*\bcrossorigin\b/i);
    // Every script/style/modulepreload tag must carry the nonce.
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const tag of scriptTags) {
      expect(tag, `script tag missing nonce: ${tag}`).toMatch(/\bnonce=/);
    }
    const modulePreloadTags =
      html.match(/<link\b[^>]*rel\s*=\s*["']modulepreload["'][^>]*>/gi) ?? [];
    for (const tag of modulePreloadTags) {
      expect(tag, `modulepreload tag missing nonce: ${tag}`).toMatch(/\bnonce=/);
    }
  });

  it('(f) dashboard render throws if toLocalUri adapter is missing (BUG-001 contract)', async () => {
    const mod = await import('../../src/ui/dashboard/dashboard-html.js');
    expect(() =>
      mod.renderDashboardHtml({
        webview: {
          cspSource: 'vscode-resource:',
          asWebviewUri: () => ({ toString: () => '' })
        },
        extensionRoot: '/tmp/ext',
        nonce: 'abc'
        // toLocalUri intentionally omitted
      } as unknown as Parameters<typeof mod.renderDashboardHtml>[0])
    ).toThrow(/toLocalUri/);
  });

  it('(d) dashboard subscription is independent from sidebar — emit posts once per subscriber', async () => {
    const projector = new FakeProjector();

    // Sidebar-equivalent subscriber count
    const sidebarPosts: WorkflowSnapshot[] = [];
    const sidebarSub = projector.subscribe((s) => sidebarPosts.push(s));

    // Open dashboard — installs a second, independent subscriber
    DashboardPanel.open({
      extensionRoot: '/tmp/ext',
      projector,
      dispatch: vi.fn(),
      logger: new SanitizedLogger()
    });
    const dashPanel = mocks.state.panels[0];
    // Allow constructor's initial postIfVisible to settle
    await Promise.resolve();
    const initialDashPosts = dashPanel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    ).length;
    const initialSidebarCount = sidebarPosts.length;

    // Single emit must fan out to BOTH subscribers, exactly once each
    projector.emit(buildIdleSnapshot({ isPrimary: true, producedAt: '2026-05-10T01:00:00.000Z' }));
    await Promise.resolve();
    await Promise.resolve();

    const dashPostsAfter = dashPanel.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === STATE_SNAPSHOT
    ).length;
    expect(dashPostsAfter - initialDashPosts).toBe(1);
    expect(sidebarPosts.length - initialSidebarCount).toBe(1);

    sidebarSub.dispose();
  });
});
