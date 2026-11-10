import type { SanitizedLogger } from '../../lib/logger';
import type { ProjectorHandle } from '../sidebar/projector-handle';
import type { InboundDispatch } from '../sidebar/sidebar-view-provider';
import type { PhaseLogBatchPushMessage } from '../../contracts/sidebar-ipc';
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
  private onPanelDispose: (() => void) | undefined;
  private onVisibilityChange: ((visible: boolean) => void) | undefined;

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

  /** FR-R6-F07 — the panel reports its visibility here, on open and on every change. */
  public setOnVisibilityChange(onVisibilityChange: ((visible: boolean) => void) | undefined): void {
    this.onVisibilityChange = onVisibilityChange;
  }

  public openDashboard(): DashboardPanel {
    const opts: DashboardOpenOptions = {
      extensionRoot: this.extensionRoot,
      projector: this.projector,
      dispatch: this.dispatch,
      logger: this.logger,
      onDispose: this.onPanelDispose,
      onVisibilityChange: this.onVisibilityChange
    };
    return DashboardPanel.open(opts);
  }

  /**
   * FR-R6-F07 — post one phase-log batch to the active dashboard webview. Returns
   * `false` when the dashboard is closed or hidden, so the tail session suspends.
   * When the dashboard panel disposes, `onPanelDispose` releases any
   * dashboard-owned tail session with reason `webview-dispose`.
   */
  public postPhaseLogBatch(message: PhaseLogBatchPushMessage): boolean {
    return DashboardPanel.current()?.postPhaseLogBatch(message) ?? false;
  }

  public dispose(): void {
    DashboardPanel.current()?.dispose();
  }
}
