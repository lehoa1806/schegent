import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SidebarViewProvider } from '../../../../src/ui/sidebar/sidebar-view-provider';
import { PlaceholderProjector } from '../../../../src/ui/sidebar/placeholder-projector';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { CMD_OPEN_DASHBOARD } from '../../../../src/ui/sidebar/messages';

vi.mock('vscode', () => {
  return {
    window: {
      showWarningMessage: vi.fn()
    },
    Uri: {
      file: vi.fn((f) => ({ fsPath: f }))
    }
  };
});

describe('SidebarViewProvider', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new SanitizedLogger();
  });

  it('shows no-workspace message when reason is no-workspace', () => {
    const projector = new PlaceholderProjector({ reason: 'no-workspace' });
    const provider = new SidebarViewProvider({
      extensionRoot: '/test',
      projector,
      logger
    });
    
    // Set the view
    (provider as any).view = { webview: { postMessage: vi.fn() } };
    
    // Call handleInbound directly
    (provider as any).handleInbound({ type: CMD_OPEN_DASHBOARD, correlationId: '123' });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Please open a workspace to use the Schegent Dashboard.'
    );
  });

  it('shows init-failed message when reason is init-failed', () => {
    const projector = new PlaceholderProjector({ reason: 'init-failed' });
    const provider = new SidebarViewProvider({
      extensionRoot: '/test',
      projector,
      logger
    });
    
    (provider as any).view = { webview: { postMessage: vi.fn() } };
    
    (provider as any).handleInbound({ type: CMD_OPEN_DASHBOARD, correlationId: '123' });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Schegent: Workspace initialization failed. Please check the extension host logs or reset workspace state.'
    );
  });
});
