import * as vscode from 'vscode';
import type { Disposable } from '../../state/workspace-state';
import type { SanitizedLogger } from '../../lib/logger';
import type { ProjectorHandle } from '../sidebar/projector-handle';
import type { InboundDispatch } from '../sidebar/sidebar-view-provider';
import type { WorkflowSnapshot } from '../sidebar/snapshot';
import { STATE_SNAPSHOT } from '../sidebar/messages';
import type { PhaseLogEntryPushMessage } from '../../contracts/sidebar-ipc';
import { validateInboundMessage } from '../sidebar/ipc-validator';
import { generateNonce } from '../sidebar/csp';
import { renderDashboardHtml } from './dashboard-html';

export interface DashboardOpenOptions {
  readonly extensionRoot: string;
  readonly projector: ProjectorHandle;
  readonly dispatch: InboundDispatch;
  readonly logger: SanitizedLogger;
}

export class DashboardPanel {
  public static readonly viewType = 'schegent.dashboard';
  public static readonly title = 'Schegent Dashboard';
  private static currentPanel: DashboardPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly logger: SanitizedLogger;
  private readonly dispatch: InboundDispatch;
  private projectorSub: Disposable | null = null;
  private latestSnapshot: WorkflowSnapshot | null = null;
  private disposed = false;

  public static open(opts: DashboardOpenOptions): DashboardPanel {
    if (DashboardPanel.currentPanel && !DashboardPanel.currentPanel.disposed) {
      DashboardPanel.currentPanel.panel.reveal();
      return DashboardPanel.currentPanel;
    }
    const bundleDir = `${opts.extensionRoot}/dist/webview`;
    const nonce = generateNonce();
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      DashboardPanel.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(bundleDir),
          vscode.Uri.file(`${opts.extensionRoot}/resources`)
        ]
      }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, nonce, opts);
    return DashboardPanel.currentPanel;
  }

  public static current(): DashboardPanel | null {
    return DashboardPanel.currentPanel;
  }

  public static __resetForTests(): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.dispose();
    }
    DashboardPanel.currentPanel = null;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    nonce: string,
    opts: DashboardOpenOptions
  ) {
    this.panel = panel;
    this.logger = opts.logger;
    this.dispatch = opts.dispatch;

    panel.webview.html = renderDashboardHtml({
      webview: panel.webview,
      extensionRoot: opts.extensionRoot,
      nonce,
      toLocalUri: (fsPath: string) => vscode.Uri.file(fsPath)
    });

    try {
      this.latestSnapshot = opts.projector.getCurrentSnapshot();
    } catch (err) {
      this.logger.warn(`dashboard: getCurrentSnapshot failed: ${(err as Error).message}`);
    }

    this.projectorSub = opts.projector.subscribe((snapshot) => {
      this.latestSnapshot = snapshot;
      void this.postIfVisible();
    });

    panel.onDidChangeViewState(() => {
      void this.postIfVisible();
    });

    panel.webview.onDidReceiveMessage((raw) => this.handleInbound(raw));

    panel.onDidDispose(() => {
      this.dispose({ skipPanelDispose: true });
    });

    void this.postIfVisible();
  }

  private async postIfVisible(): Promise<void> {
    if (this.disposed) return;
    if (!this.panel.visible) return;
    if (!this.latestSnapshot) return;
    try {
      await this.panel.webview.postMessage({
        type: STATE_SNAPSHOT,
        payload: this.latestSnapshot
      });
    } catch (err) {
      this.logger.debug(`dashboard: postMessage failed: ${(err as Error).message}`);
    }
  }

  private handleInbound(raw: unknown): void {
    if (this.disposed) return;
    const result = validateInboundMessage(raw);
    if (!result.ok) {
      // Feature 020 BUG-001 T071: surface type + correlationId so a
      // future drop event can be attributed to the rejected command
      // without source-level inspection. Both fields pass through
      // `SanitizedLogger` unchanged (command names and UUID
      // correlation ids are not secret).
      this.logger.debug(
        `dashboard: dropping invalid message (reason=${result.reason} type=${result.type ?? 'unknown'} correlationId=${result.correlationId ?? 'unknown'})`
      );
      return;
    }
    void this.dispatch(result.command, (ack) => this.panel.webview.postMessage(ack));
  }

  /**
   * Feature 020 — push a phase-log tail entry to the dashboard webview.
   * The registry owns sanitization + truncation; the panel only relays.
   * No-op when the panel is disposed (the tail registry tears down on
   * webview-dispose so this is a safety net for late posts).
   */
  public postPhaseLogEntry(envelope: PhaseLogEntryPushMessage): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(envelope).then(
      undefined,
      (err: Error) =>
        this.logger.debug(
          `dashboard: phase-log postMessage failed: ${err.message}`
        )
    );
  }

  public dispose(opts: { skipPanelDispose?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projectorSub?.dispose();
    this.projectorSub = null;
    if (DashboardPanel.currentPanel === this) {
      DashboardPanel.currentPanel = null;
    }
    if (!opts.skipPanelDispose) {
      try {
        this.panel.dispose();
      } catch {
        /* panel may already be disposed */
      }
    }
  }
}
