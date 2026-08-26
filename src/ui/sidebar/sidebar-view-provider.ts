import * as vscode from 'vscode';
import type { SanitizedLogger } from '../../lib/logger';
import { renderWebviewHtml, cspPlaceholderHtml, FALLBACK_FAILURE_HTML } from './html';
import { generateNonce } from './csp';
import { validateInboundMessage } from './ipc-validator';
import type { ProjectorHandle } from './projector-handle';
import type { SidebarCommand, CommandAckMessage } from './messages';
import { STATE_SNAPSHOT, CMD_OPEN_DASHBOARD, CMD_ACK } from './messages';
import type { Disposable } from '../../state/workspace-state';
import { PlaceholderProjector } from './placeholder-projector';

export type InboundDispatch = (
  command: SidebarCommand,
  ack: (msg: CommandAckMessage) => Thenable<boolean> | Promise<boolean>
) => void | Promise<void>;

export interface SidebarViewProviderOptions {
  readonly extensionRoot: string;
  readonly projector: ProjectorHandle;
  readonly dispatch?: InboundDispatch;
  readonly logger: SanitizedLogger;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'schegent.sidebar';

  private view: vscode.WebviewView | null = null;
  private projectorSub: Disposable | null = null;
  private projector: ProjectorHandle;
  private dispatcher: InboundDispatch | null;
  private readonly extensionRoot: string;
  private readonly logger: SanitizedLogger;

  constructor(options: SidebarViewProviderOptions) {
    this.projector = options.projector;
    this.dispatcher = options.dispatch ?? null;
    this.extensionRoot = options.extensionRoot;
    this.logger = options.logger;
  }

  public setProjector(projector: ProjectorHandle): void {
    this.projector = projector;
    if (this.view) {
      this.projectorSub?.dispose();
      this.projectorSub = projector.subscribe((snapshot) => {
        void this.postSnapshot(snapshot);
      });
    }
  }

  public setDispatch(dispatch: InboundDispatch | null): void {
    this.dispatcher = dispatch;
  }

  public async resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = view;
    const bundleDir = `${this.extensionRoot}/dist/webview`;

    // BUG-004 ordering: assign `webview.html` (with CSP) BEFORE `webview.options`.
    // VS Code's `created a webview without a content security policy` warning
    // appears to latch when `options` materialises the iframe content frame,
    // before any subsequent `html` write applies. Setting the CSP-bearing
    // placeholder first forestalls the latch. See plan.md
    // "Webview Sanitization Contract" rule 6.
    view.webview.html = cspPlaceholderHtml(view.webview, generateNonce());

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(bundleDir),
        vscode.Uri.file(`${this.extensionRoot}/resources`)
      ]
    };

    try {
      const { html } = await renderWebviewHtml({
        webview: view.webview,
        extensionRoot: this.extensionRoot,
        webviewBundleDir: bundleDir,
        // BUG-004: real `vscode.Webview.asWebviewUri` requires a `vscode.Uri`
        // instance, not a duck-typed `{ fsPath }` literal. The renderer cannot
        // import `vscode` directly (it runs under node-only unit tests), so the
        // caller injects the adapter. See plan.md "Webview Sanitization
        // Contract" rule 7.
        toLocalUri: (fsPath: string) => vscode.Uri.file(fsPath)
      });
      view.webview.html = html;
    } catch (err) {
      this.logger.warn(`sidebar: failed to render html: ${(err as Error).message}`);
      view.webview.html = FALLBACK_FAILURE_HTML;
      return;
    }

    view.webview.onDidReceiveMessage((raw) => this.handleInbound(raw));

    this.projectorSub?.dispose();
    this.projectorSub = this.projector.subscribe((snapshot) => {
      void this.postSnapshot(snapshot);
    });

    view.onDidDispose(() => {
      this.projectorSub?.dispose();
      this.projectorSub = null;
      this.view = null;
    });
  }

  public dispose(): void {
    this.projectorSub?.dispose();
    this.projectorSub = null;
    this.view = null;
  }

  private async postSnapshot(snapshot: unknown): Promise<void> {
    const view = this.view;
    if (!view) return;
    try {
      await view.webview.postMessage({ type: STATE_SNAPSHOT, payload: snapshot });
    } catch (err) {
      this.logger.debug(`sidebar: postMessage failed: ${(err as Error).message}`);
    }
  }

  private handleInbound(raw: unknown): void {
    const result = validateInboundMessage(raw);
    if (!result.ok) {
      // FR-R3-102 (FR-037) — `warn`, not `debug`.
      //
      // This is a TRUST BOUNDARY rejection: the webview is the untrusted side, and a
      // message that fails validation is either a defect or a probe. The default
      // runtime log level is INFO (`settings-schema.ts` `runtimeLogLevel`), so at
      // `debug` a probing webview was **invisible at default settings** — the host
      // dropped the message correctly and told nobody. `ARCHITECTURE.md` had claimed
      // for a year that these were "audited as `audit.invalid_command`"; no such
      // event has ever existed, and the claim is corrected there rather than here.
      //
      // `warn` is the floor, not the destination. An audit event is the shape the
      // document always promised and is the stronger answer, recorded as the
      // destination in `ARCHITECTURE.md` rather than built here — the audit
      // vocabulary is a closed union with parity gates on both sides of the boundary,
      // so adding a member is its own change with its own tests.
      //
      // `result.reason` is a closed reason code from the validator, never
      // operator-authored text, so it is safe on this path.
      this.logger.warn(`sidebar: rejected invalid message (${result.reason})`);
      return;
    }
    const view = this.view;
    if (!view) return;
    const dispatch = this.dispatcher;
    if (!dispatch) {
      if (result.command.type === CMD_OPEN_DASHBOARD) {
        if (this.projector instanceof PlaceholderProjector && this.projector.reason === 'init-failed') {
          void vscode.window.showWarningMessage('Schegent: Workspace initialization failed. Please check the extension host logs or reset workspace state.');
        } else {
          void vscode.window.showWarningMessage('Please open a workspace to use the Schegent Dashboard.');
        }
        void view.webview.postMessage({ type: CMD_ACK, correlationId: result.command.correlationId, status: 'accepted' });
        return;
      }
      this.logger.warn(`sidebar: no dispatcher registered for ${result.command.type}`);
      return;
    }
    void dispatch(result.command, (ack) => view.webview.postMessage(ack));
  }
}
