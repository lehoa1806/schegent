import type { SanitizedLogger } from '../../lib/logger';
import type { ProjectorHandle } from '../sidebar/projector-handle';
import type { InboundDispatch } from '../sidebar/sidebar-view-provider';
import type { PhaseLogEntryPushMessage } from '../../contracts/sidebar-ipc';
import { DashboardPanel, type DashboardOpenOptions } from './dashboard-panel';

export interface DashboardBridgeOptions {
  readonly extensionRoot: string;
  readonly projector: ProjectorHandle;
  readonly dispatch: InboundDispatch;
  readonly logger: SanitizedLogger;
  readonly onPanelDispose?: () => void;
}

export class DashboardBridge {
  private readonly extensionRoot: string;
  private readonly logger: SanitizedLogger;
  private projector: ProjectorHandle;
  private dispatch: InboundDispatch;
  private onPanelDispose?: () => void;

  constructor(opts: DashboardBridgeOptions) {
    this.extensionRoot = opts.extensionRoot;
    this.projector = opts.projector;
    this.dispatch = opts.dispatch;
    this.logger = opts.logger;
    this.onPanelDispose = opts.onPanelDispose;
  }

  public setProjector(projector: ProjectorHandle): void {
    this.projector = projector;
  }

  public setDispatch(dispatch: InboundDispatch): void {
    this.dispatch = dispatch;
  }

  public setOnPanelDispose(onPanelDispose: (() => void) | undefined): void {
    this.onPanelDispose = onPanelDispose;
  }

  public openDashboard(): DashboardPanel {
    const opts: DashboardOpenOptions = {
      extensionRoot: this.extensionRoot,
      projector: this.projector,
      dispatch: this.dispatch,
      logger: this.logger,
      onDispose: this.onPanelDispose
    };
    return DashboardPanel.open(opts);
  }

  /**
   * Feature 020 / FR-R5-F10 — push a phase-log tail entry to the active
   * dashboard webview. No-op when the dashboard is closed or hidden. When the
   * dashboard panel disposes, `onPanelDispose` releases any dashboard-owned
   * tail session with reason `webview-dispose`.
   */
  public postPhaseLogEntry(envelope: PhaseLogEntryPushMessage): void {
    DashboardPanel.current()?.postPhaseLogEntry(envelope);
  }

  public dispose(): void {
    DashboardPanel.current()?.dispose();
  }
}
