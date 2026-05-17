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
}

export class DashboardBridge {
  private readonly extensionRoot: string;
  private readonly logger: SanitizedLogger;
  private projector: ProjectorHandle;
  private dispatch: InboundDispatch;

  constructor(opts: DashboardBridgeOptions) {
    this.extensionRoot = opts.extensionRoot;
    this.projector = opts.projector;
    this.dispatch = opts.dispatch;
    this.logger = opts.logger;
  }

  public setProjector(projector: ProjectorHandle): void {
    this.projector = projector;
  }

  public setDispatch(dispatch: InboundDispatch): void {
    this.dispatch = dispatch;
  }

  public openDashboard(): DashboardPanel {
    const opts: DashboardOpenOptions = {
      extensionRoot: this.extensionRoot,
      projector: this.projector,
      dispatch: this.dispatch,
      logger: this.logger
    };
    return DashboardPanel.open(opts);
  }

  /**
   * Feature 020 — push a phase-log tail entry to the active dashboard
   * webview. No-op when the dashboard is not open. The PhaseLogTailRegistry
   * tears down on webview-dispose, so visibility transitions while a
   * tail is active are owned by the registry, not buffered here.
   */
  public postPhaseLogEntry(envelope: PhaseLogEntryPushMessage): void {
    DashboardPanel.current()?.postPhaseLogEntry(envelope);
  }

  public dispose(): void {
    DashboardPanel.current()?.dispose();
  }
}
