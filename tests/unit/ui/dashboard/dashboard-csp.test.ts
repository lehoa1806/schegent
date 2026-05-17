import { describe, expect, it } from 'vitest';
import { renderDashboardHtml } from '../../../../src/ui/dashboard/dashboard-html';
import { FORBIDDEN_TOKENS } from '../../../../src/ui/sidebar/csp';
import type { UriLike } from '../../../../src/ui/sidebar/html';

const cspSource = 'https://w.example.vscode-webview.net';

class FakeWebview {
  readonly cspSource = cspSource;
  asWebviewUri(local: UriLike): { toString(): string } {
    return { toString: () => `${this.cspSource}/${local.fsPath}` };
  }
}

const toLocalUri = (fsPath: string): UriLike => ({ fsPath, scheme: 'file' });

describe('Dashboard webview CSP', () => {
  it('emits the same strict CSP meta as the sidebar (no remote scripts, nonce required)', () => {
    const nonce = 'a'.repeat(32);
    const html = renderDashboardHtml({
      webview: new FakeWebview(),
      extensionRoot: '/nonexistent-dashboard-csp-test',
      nonce,
      toLocalUri,
      webviewBundleDir: '/nonexistent-dashboard-csp-test/dist'
    });
    expect(html).toMatch(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
    expect(html).toContain(`'nonce-${nonce}'`);
    expect(html).toContain(`default-src 'none'`);
    for (const token of FORBIDDEN_TOKENS) {
      expect(html, `forbidden token "${token}" present in dashboard HTML`).not.toContain(token);
    }
  });

  it('rejects callers that pass a non-Uri-shaped toLocalUri argument', () => {
    expect(() =>
      renderDashboardHtml({
        webview: new FakeWebview(),
        extensionRoot: '/nonexistent',
        nonce: 'b'.repeat(32),
        toLocalUri: undefined as unknown as (fsPath: string) => UriLike,
        webviewBundleDir: '/nonexistent/dist'
      })
    ).toThrow(/toLocalUri/);
  });
});
