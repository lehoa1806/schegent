import type { WorkspaceFolder } from 'vscode';
import type { DashboardBridge } from '../ui/dashboard/dashboard-bridge';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';

export const STATIC_MESSAGE = 'runOpenDashboard gated: no workspace folder open';
export const STATIC_TEXT = 'Please open a workspace to use the Schegent Dashboard.';

let warningInFlight = false;

export function _resetWarningInFlightForTests(): void {
  warningInFlight = false;
}

export interface OpenDashboardCtx {
  readonly bridge: DashboardBridge;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  readonly getWorkspaceFolders: () => readonly WorkspaceFolder[] | undefined;
}

export async function runOpenDashboard(
  _arg: unknown,
  ctx: OpenDashboardCtx
): Promise<void> {
  const folders = ctx.getWorkspaceFolders();
  if (folders === undefined || folders.length === 0) {
    if (warningInFlight) {
      return;
    }
    warningInFlight = true;
    ctx.logger.warn(STATIC_MESSAGE);
    const reset = (): void => {
      warningInFlight = false;
    };
    void Promise.resolve(ctx.notifier.warn(STATIC_TEXT)).then(reset, reset);
    return;
  }
  try {
    ctx.bridge.openDashboard();
  } catch (err) {
    ctx.logger.error(`runOpenDashboard failed: ${(err as Error).message}`);
    ctx.notifier.error('Schegent: failed to open dashboard.');
  }
}
