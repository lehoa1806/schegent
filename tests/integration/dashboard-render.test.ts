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

  it('(b) dashboard bundle references the operations-surface layout-zone testids', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const bundlePath = path.join(repoRoot, 'dist', 'webview', 'dashboard.js');
    if (!fs.existsSync(bundlePath)) {
      console.warn(`[T062] skipping bundle check: ${bundlePath} not found (run npm run build:webview)`);
      return;
    }
    // The claim is that the zones ship, not which chunk they land in. Feature 092
    // moved the drill-down tiers behind dynamic imports, so the zones emit into
    // `chunks/QueueDetailTier.js` rather than the entry — a chunking decision the
    // bundler owns and this assertion should not pin. Feature 097 (T013) deleted
    // `Dashboard.svelte` and its subtree outright, so the original FR-033 zone
    // testids (`dashboard-queue-management`, `dashboard-queue-list`,
    // `dashboard-activity-audit-feed`) no longer exist anywhere; this list now
    // names each zone's direct successor in the tier components
    // (`QueueControls.svelte`, `QueueDetailRows.svelte`, `PhaseLogFeed.svelte`).
    const chunkDir = path.join(repoRoot, 'dist', 'webview', 'chunks');
    const bundleSource = [
      bundlePath,
      ...(fs.existsSync(chunkDir)
        ? fs
            .readdirSync(chunkDir)
            .filter((name) => name.endsWith('.js'))
            .map((name) => path.join(chunkDir, name))
        : [])
    ]
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(bundleSource).toContain('dashboard-queue-input');
    expect(bundleSource).toContain('dashboard-queue-action');
    expect(bundleSource).toContain('queue-detail-rows');
    expect(bundleSource).toContain('dashboard-phase-progression');
    expect(bundleSource).toContain('phase-log-feed');
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
    const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9_-]+)'/)?.[1];
    expect(cspNonce).toBeTruthy();
    expect(html).toContain(`<meta property="csp-nonce" nonce="${cspNonce}"/>`);
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

  it('(g) lazy route assets resolve relative to the dashboard module (BUG-002)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const bundlePath = path.join(repoRoot, 'dist', 'webview', 'dashboard.js');
    if (!fs.existsSync(bundlePath)) {
      console.warn(
        `[BUG-002] skipping lazy-asset check: ${bundlePath} not found (run npm run build:webview)`
      );
      return;
    }

    const bundleSource = fs.readFileSync(bundlePath, 'utf8');
    const cssDependencies = [...bundleSource.matchAll(/["']([^"']+\.css)["']/g)].map(
      (match) => match[1]
    );

    expect(cssDependencies.length).toBeGreaterThan(0);
    expect(
      cssDependencies.every((dependency) => dependency.startsWith('./')),
      `lazy CSS must be module-relative for VS Code webviews: ${cssDependencies.join(', ')}`
    ).toBe(true);
    expect(bundleSource).toContain('import.meta.url');
    expect(bundleSource).toContain('meta[property=csp-nonce]');
    expect(bundleSource).toMatch(/new URL\([^)]*,[^)]*\)\.href/);
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
